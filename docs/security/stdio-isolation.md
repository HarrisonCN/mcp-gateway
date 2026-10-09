# Isolating stdio MCP servers (12.0)

stdio MCP servers are third-party code that the gateway starts as child processes. Since 12.0 they are separated
from the gateway core in three ways: **environment**, **identity / files**, and **network**.

## 1. Environment: allowlist

A child inherits only this minimal set from the gateway's environment:

| Platform | Variables |
|---|---|
| all | `PATH`, `HOME`, `LANG`, `LANGUAGE`, `LC_*`, `TZ`, `TMPDIR`, `TERM` |
| Windows (also) | `SystemRoot`, `ComSpec`, `PATHEXT`, `TEMP`, `TMP`, `USERPROFILE`, `APPDATA`, `LOCALAPPDATA`, `windir` |

Everything else — `AWS_SECRET_ACCESS_KEY`, `OPENAI_API_KEY`, `DATABASE_URL`, `MCP_GATEWAY_*`, … — is **not** passed.
(≤ 11.x used an exclusion policy: everything except `MCP_GATEWAY_*` was inherited.)

Give a server what it needs explicitly:

```yaml
security:
  stdioEnvPassthrough: [NODE_EXTRA_CA_CERTS, HTTPS_PROXY]   # every stdio server
servers:
  - id: github
    transport: stdio
    command: npx
    args: ["-y", "@modelcontextprotocol/server-github"]
    env:
      GITHUB_PERSONAL_ACCESS_TOKEN: ${GITHUB_MCP_TOKEN}      # explicit value (${VAR} is expanded)
    envPassthrough: [GIT_*]                                  # names or PREFIX_* globs
```

Passing a credential-looking name through (`*TOKEN*`, `*SECRET*`, `*API_KEY*`, `*PASSWORD*`, `*_URL`, …) is allowed
but reported by `mcp-gateway validate` / the startup posture check (`stdio-secret-passthrough`): prefer a dedicated,
narrowly scoped credential in `env`.

## 2. Identity, working directory and files

```yaml
    isolation:
      uid: 1001            # POSIX; the gateway must be allowed to switch user (root or CAP_SETUID/CAP_SETGID)
      gid: 1001
      cwd: /srv/mcp/github # absolute, or relative to the config file
```

Run each untrusted server as a dedicated unprivileged user that cannot read the gateway's config, keys or state.

## 3. Sandbox wrapper and network

```yaml
    isolation:
      cwd: /srv/mcp/files
      sandbox:
        type: bubblewrap      # bubblewrap | firejail | container | custom
        network: none         # default; `host` shares the host network
        writable: [/data]     # extra read-write paths (cwd always is)
        readable: [/models]   # extra read-only paths
```

| `type` | What runs |
|---|---|
| `bubblewrap` | `bwrap --unshare-all [--share-net] --clearenv --setenv … --ro-bind-try /usr … --bind <cwd> --chdir <cwd> -- <command> <args>` — system dirs read-only, private `/tmp`, `/proc`, `/dev`; nothing of `$HOME` |
| `firejail` | `firejail --noprofile --private-tmp --caps.drop=all --nonewprivs --seccomp [--net=none] --whitelist=<cwd> -- <command> <args>` |
| `container` | `<runtime> run --rm -i --network none --read-only --cap-drop=ALL --security-opt=no-new-privileges -v <cwd>:<cwd> -e NAME… <image> <command> <args>` (`image` required, `runtime` default `docker`; `uid`/`gid` become `--user`; variable values are passed through the runtime's environment, never argv) |
| `custom` | your argv template with `{command}`, `{args}`, `{cwd}`, `{network}` — e.g. `["nsjail", "-Mo", "--cwd", "{cwd}", "--", "{command}", "{args}"]` |

The wrapper binary must be installed on the gateway host. The gateway does not verify that a sandbox is effective;
test it (`network: none` → the server cannot resolve DNS).

## Migration from 11.x

1. Start 12.0 with your config and watch for stdio servers that fail to start or report missing credentials.
2. For each, add the variables it needs to `env` (preferred) or `envPassthrough`.
3. Variables every server needs (proxy, CA bundle) go to `security.stdioEnvPassthrough`.

See also: [threat model](threat-model.md).
