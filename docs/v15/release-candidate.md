# 15.0.0 release candidate

> **15.0.0-rc.1 is a pre-release, published after 14.9.0.** Check `npm view @winstonsayno/mcp-gateway dist-tags` — until
> `next` shows `15.0.0-rc.1` it is not out yet. When published it is under the npm dist-tag `next` (not `latest`) and as the image tag
> `ghcr.io/harrisoncn/mcp-gateway:15.0.0-rc.1` only (not `latest`, not `15`). Production deployments stay on 14.x
> (`latest`, currently 14.9.0) until 15.0.0 ships.

```bash
npm i @winstonsayno/mcp-gateway@next          # 15.0.0-rc.1
docker pull ghcr.io/harrisoncn/mcp-gateway:15.0.0-rc.1
```

What the candidate contains: everything in 14.9.0 plus the 15.0 changes from the [freeze list](freeze.md) —
schema v11 files refused, module plugins in a `worker` by default, unknown top-level keys refused, `schema/v12-draft`
removed. Upgrade steps: [migrating to v15](../migrating-to-v15.md).

## What is not done yet (15.0.0 gates)

The candidate is published so the frozen surface can be tried before 15.0.0; it does not claim the v15 gates are met:

- [ ] 72 h soak with fault injection on two instances (`soak.yml`, see [release gates](../release-gates.md#v15-gates)) —
      14.9.0 ran a 30-minute soak only
- [ ] comparison with the v13.3 baseline on fixed, dedicated hardware
- [ ] independent security audit or external expert review
- [x] migration and rollback from 13.x / 14.x verified (tests above)

Report problems with the candidate as GitHub issues labelled `15.0-rc`; security issues through private
vulnerability reporting ([SECURITY.md](../../SECURITY.md)).
