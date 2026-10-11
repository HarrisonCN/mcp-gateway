# Versions and support policy

How releases are tagged and how long each line is maintained. The supported-versions table in
[SECURITY.md](../SECURITY.md) is the current state of this policy.

## Release lines

| Line | Role | npm dist-tag | Image tags | Branch | Fixes |
|---|---|---|---|---|---|
| 14.x | current | `latest` | `latest`, `14`, `14.<minor>`, `<version>` | `main` | features, bug and security fixes |
| 13.9.x | maintained (previous major) | `v13-lts` | `13`, `13.9`, `<version>` | `lts/13.x` | security and critical bug fixes, at least until 15.0.0 ships and no earlier than 2027-04-30 |
| 12.0.x | superseded, security backports | `v12-0` | `12`, `12.0`, `<version>` | `lts/12.x` | security fixes while 13.9.x is maintained |
| 10.x | long-term support | `v10-lts` | `10`, `10.9`, `<version>` | `lts/10.x` | bug and security fixes until 2027-10-31, then security fixes only until 2028-10-31 |
| other | unsupported | — | — | — | upgrade |

## Rules

- **Semantic versioning.** Breaking changes only in a major release, listed under "Breaking changes" in the
  [CHANGELOG](../CHANGELOG.md) with a migration guide (`docs/migration/`, earlier ones in `docs/guides/`) that includes
  rollback steps.
- **`latest` follows the current major.** A new major takes npm `latest` and the `latest` image tag when it is
  released. The previous major's last minor becomes a maintained line with its own dist-tag (`v<major>-lts`; npm
  refuses dist-tags that are semver ranges such as `v13`) and keeps its major image tag (`:13`).
- **Config schema.** A major may change the config schema. The previous schema is still read — migrated in memory with
  one deprecation warning per field and a startup notice — for the whole next major, and removed in the major after
  it (schema v11: read by 14.x, removed in 15.0.0). `mcp-gateway config migrate` rewrites files.
- **Deprecations** are announced at least one minor release before the major that removes them
  ([docs/deprecations.md](deprecations.md)) and are reported at run time, by `mcp-gateway validate` and by
  `GET /api/v1/admin/deprecations`.
- **Security fixes** ship in the current line and are backported to every maintained line they affect, as patch
  releases of that line (advisories in [SECURITY.md](../SECURITY.md)).
- **Release gates.** Nothing is published unless every required check is green on the merge commit
  ([docs/release-gates.md](release-gates.md)) — on `main` and on the `lts/*` branches.
