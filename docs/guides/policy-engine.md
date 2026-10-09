# Policy-as-code 2.0: Cedar and OPA (10.5)

`features.policyEngine` adds two policy engines on top of the built-in `policy.rules`
([policy as code](policy-as-code.md)), evaluated on every tool call (REST and `/mcp`). A call must be allowed by
`policy.rules` **and** by the engine.

- **Cedar** — policies in the [Cedar language](https://docs.cedarpolicy.com/), parsed and evaluated in-process by
  the gateway's own implementation of a Cedar **subset** (no external dependency).
- **Rego via OPA** — the gateway does not interpret Rego; it asks an [Open Policy Agent](https://www.openpolicyagent.org/)
  server you run (`POST <url>/v1/data/<path>` with `{ "input": … }`).

```yaml
features:
  policyEngine:
    mode: enforce                 # shadow: evaluate and record would-be denials, never block
    cedar: |
      @id("read-anything")
      permit(principal, action == Action::"callTool", resource) when { resource.tool like "read_*" };

      @id("tmp-writes")
      permit(principal, action, resource in Server::"fs")
        when { resource.tool == "write_file" && context.args.path like "/tmp/*" };

      @id("interns-no-delete")
      forbid(principal in Tenant::"interns", action, resource) when { resource.tool like "*delete*" };
    cedarFiles: [policies/team.cedar]   # relative to the config file, appended to `cedar`
    opa:
      url: http://opa:8181
      path: mcp/gateway/allow           # result: true / false, or { allow, reason }
      timeoutMs: 500
      onError: deny                     # OPA unreachable / timeout / HTTP error → deny (or allow)
    tests:
      - name: interns cannot delete
        request: { client: "key:bob", tenant: interns, server: fs, tool: delete_file }
        expect: deny
      - name: anyone can read
        request: { server: fs, tool: read_file, args: { path: /etc/hosts } }
        expect: allow
```

## Decisions

- **Cedar default deny.** Once Cedar policies are configured, a call that no `permit` matches is denied, and any
  satisfied `forbid` wins over permits. Start in `mode: shadow` and check `GET /api/v1/admin/policy-engine` before
  enforcing.
- A Cedar policy whose condition errors (missing attribute, type mismatch) does not apply; the error is logged and
  returned by `/evaluate`. Use `has` before optional attributes: `context.args has path && context.args.path like …`.
- **OPA**: `true` / `{ allow: true }` allows; `false`, `{ allow: false, reason }` or an undefined result (wrong path)
  denies; transport errors follow `onError`.
- With both engines, both must allow. Denials are `403` (REST) / `-32003` (`/mcp`) with the deciding policy ids.

## Request model

| Cedar | Value |
|---|---|
| `principal` | `Client::"<client id>"` — `key:<name>`, `jwt:<sub>`, `oauth:<sub>`; attributes `id`, `tenant`; member of `Tenant::"<tenant>"` |
| `action` | `Action::"callTool"` |
| `resource` | `Tool::"<server>/<tool>"`; attributes `server`, `tool`; member of `Server::"<server>"` |
| `context` | `args` (tool arguments), `tenant`, `via` (`rest` / `mcp`), `time` (ISO 8601), `hour` and `weekday` (UTC) |

OPA `input`: `{ client, tenant, server, tool, arguments, via, time }`.

## Supported Cedar subset

Supported: `permit` / `forbid`; scope constraints `==`, `in` (entity, or a list for `action`), `is Type [in …]`;
`when` / `unless`; annotations (`@id` names the policy); `&& || !`, `== != < <= > >=`, `+ - *`, `in`, `like` (`*`
wildcard, `\*` literal), `has`, `is`, `if … then … else …`, attribute access (`.a`, `["a"]`), set and record
literals, `.contains()`, `.containsAll()`, `.containsAny()`, `.isEmpty()`, entity literals (`Type::"id"`,
namespaced `A::B::"id"`).

Not supported (rejected when the config is validated): extension functions (`ip()`, `decimal()`, `datetime()`),
policy templates (`?principal`), Cedar schemas / validation, entity stores beyond the request model above. Policies
written for full Cedar that stay inside this subset evaluate the same way; anything outside it is a configuration
error rather than a silent difference.

## Tests and change impact

- `mcp-gateway policy test -c mcp-gateway.yml` runs `policy.tests` and `features.policyEngine.tests` (OPA tests call
  the configured OPA) and exits `1` on a failure — put it in CI.
- `POST /api/v1/admin/policy-engine/test` runs the configured tests, or `{ "tests": [...] }` from the body.
- `POST /api/v1/admin/policy-engine/evaluate` `{ client?, tenant?, server, tool, arguments? }` → decision, deciding
  policies, errors, OPA answer.
- `POST /api/v1/admin/policy-engine/impact` `{ "cedar": "<candidate policies>", "calls"?: [...] }` replays past calls
  (captured calls with arguments when `replay.enabled`, else recent request metrics without arguments, or the calls
  you pass) under the current and the candidate Cedar policies and lists every decision that changes. OPA is not
  replayed.
- `GET /api/v1/admin/policy-engine` — status, loaded policy ids, shadow-mode would-deny counts and recent entries.

Tested in `test/policy-engine-10-5.test.ts` (including a property test: arbitrary JSON arguments never make the
evaluator throw).
