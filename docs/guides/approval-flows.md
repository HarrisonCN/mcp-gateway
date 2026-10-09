# Approvals 2.0 (7.7)

Policy rules with `effect: approve` (1.x) hold a call until *an operator* approves it. **Approval flows** model how
approvals work in a real organisation: several steps, each with its own approvers and quorum, steps that apply only
above a threshold, and escalation when nobody answers.

```yaml
features:
  approvalFlows:
    flows:
      - id: payments
        tools: ["payments/transfer", "payments/refund"] # server/tool globs
        clients: ["key:agent-*"] # optional: only these callers
        when: [{path: amount, op: gte, value: 1000}] # optional: only these calls
        timeoutSeconds: 900 # then the call is refused (expired)
        steps:
          - name: lead
            approvers: ["key:lead-*", "oidc:alice@example.com"]
          - name: finance
            approvers: ["key:fin-*"]
            required: 2 # two different finance approvers
            when: [{path: amount, op: gte, value: 10000}]
            escalateAfterSeconds: 300
            escalateTo: ["key:cfo"] # may approve this step after 5 minutes
```

- The first flow whose `tools`, `clients` and `when` match holds the call; its steps whose `when` matches run in
  order. A denial at any step, or the timeout, refuses the call with JSON-RPC **-32004** (`data.flow`, `data.step`,
  `data.approval`, `data.requestId`).
- **Conditions** — `{ path, op, value }` on the arguments: `path` is a dot path (`order.total`); `op` is one of
  `eq`, `ne`, `gt`, `gte`, `lt`, `lte`, `in` (array value), `matches` (regular expression), `exists`.
- **Approvers** are client-id globs (`key:<name>`, `jwt:<sub>`, `oidc:<email>`, …) — any authenticated client, not
  only operators. Nobody approves their own call, and each client approves a step once.
- Flows run alongside 1.x approvals (`policy` rules) — a call can be held by both.

## Approver API (any authenticated client)

| | |
|-|-|
| `GET /api/v1/features/approval-flows/inbox` | requests whose current step the caller may approve |
| `GET /api/v1/features/approval-flows/mine` | the caller's own held and recent requests |
| `POST /api/v1/features/approval-flows/:id/approve` / `deny` | `{ reason? }` |

## Operator API

| | |
|-|-|
| `GET /api/v1/admin/approval-flows[/:id]` | flows, pending and recent requests (steps, approvals, escalation) |
| `POST /api/v1/admin/approval-flows/:id/approve` / `deny` | override: completes / denies the current step as `operator:<id>` |
| `POST /api/v1/admin/approval-flows/evaluate` | `{ server, tool, client?, arguments? }` → which flow and steps would hold the call |

Feature modules can expose routes to every authenticated client under `/api/v1/features/<id>` (`mountClient`, 7.7).
