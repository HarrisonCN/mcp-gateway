# 15.0.0 release candidate

> **15.0.0-rc.4 is a pre-release.** It is published under the npm dist-tag `next` (not `latest`) and as the image tag
> `ghcr.io/harrisoncn/mcp-gateway:15.0.0-rc.4` only (not `latest`, not `15`). Production deployments stay on 14.x
> (`latest`, currently 14.9.2) until 15.0.0 ships.

```bash
npm i @winstonsayno/mcp-gateway@next          # 15.0.0-rc.4
docker pull ghcr.io/harrisoncn/mcp-gateway:15.0.0-rc.4
```

What the candidate contains: everything in 14.9.2 plus the 15.0 changes from the [freeze list](freeze.md) —
schema v11 files refused, module plugins in a `worker` by default, unknown top-level keys refused, `schema/v12-draft`
removed. Upgrade steps: [migrating to v15](../migrating-to-v15.md).

rc.4 changes only how the image is built: the Dockerfile's builder stage (dev `npm ci` + tsc, architecture-independent
output) runs on the build host instead of under QEMU emulation for arm64, which crashed and hung the 14.9.2 image build.
The runner stage is still built per platform. No change to the package contents or the frozen surface.

## What is not done yet (15.0.0 gates)

The candidate is published so the frozen surface can be tried before 15.0.0; it does not claim the v15 gates are met
(how each gate is run and closed: [v15 gates](gates.md)):

- [ ] 72 h soak with fault injection on two instances (`soak.yml`, see [release gates](../release-gates.md#v15-gates)) —
      only 30- to 90-minute soaks so far (14.9.0, 14.9.1 / rc.2)
- [ ] comparison with the v13.3 baseline on fixed, dedicated hardware
- [ ] independent security audit or external expert review
- [x] migration and rollback from 13.x / 14.x verified (tests above)

## Memory growth (rc.1 known issue — fixed in rc.2 / 14.9.1)

rc.1 and 14.9.0 grew about 600 MB/h in the 30-minute soak (`scripts/soak.mjs`, 2 instances + Redis; 13.3.0: about
30 MB/h with the same harness). Cause: the durable sweep's full pass loaded every retained task-graph run record at
once, so its peak heap — and the process RSS — rose with every run kept. rc.2 and 14.9.1 read the records in chunks
and drop deleted runs from the run index: +97 MB/h in the same 30-minute soak, with the request log (capped at 100 000
entries) still filling during that window.

rc.3 and 14.9.2 also bound the durable run ids each instance keeps in memory (at most 50 000; older ids are read
back from the store's run index). Before, every retained run cost about 0.2 KB per instance until `retentionHours`
deleted it — about +4 MB/h at the soak's 6 runs/s, about 680 MB at the default 168 h. An in-process harness (one
instance + Redis, request log cap lowered) separates the two remaining sources: the request log is flat once capped,
and with the fix 60 000 runs leave the heap flat (rc.2: 30 → 46 MB). Gate A — the 72-hour soak — has not been run.

Report problems with the candidate as GitHub issues labelled `15.0-rc`; security issues through private
vulnerability reporting ([SECURITY.md](../../SECURITY.md)).
