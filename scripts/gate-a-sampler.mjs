#!/usr/bin/env node
// v15 gate A: RSS sampler for a running scripts/soak.mjs. Every --every (default 10 s) it finds the soak's gateway
// processes (cmdline "<impl>/dist/cli.js start -c <dir>/gw-<A|B>.yml") and appends one JSON line per instance —
// {ts, inst, pid, rssMb} — to --out. Lines are appended as they are taken, so a run that dies (power loss, reboot,
// OOM) still leaves its memory curve. Exits when the --soak-pid process is gone. Read-only: never signals anything.
//
//   node scripts/gate-a-sampler.mjs --soak-pid <pid> --out rss.jsonl [--impl <package dir>] [--every 10s]
import { readdirSync, readFileSync, appendFileSync } from 'node:fs';

const argv = process.argv.slice(2);
const opt = (n, d) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : d; };
const SOAK = opt('soak-pid'); const OUT = opt('out'); const IMPL = opt('impl');
const EVERY = Number(/^(\d+)s?$/.exec(opt('every', '10s'))?.[1] ?? 10) * 1000;
if (!SOAK || !OUT) { console.error('usage: gate-a-sampler.mjs --soak-pid <pid> --out rss.jsonl [--impl dir]'); process.exit(2); }
if (process.platform !== 'linux') { console.error('gate-a-sampler needs Linux /proc'); process.exit(2); }
const cli = IMPL ? `${IMPL.replace(/\/$/, '')}/dist/cli.js` : null;
const alive = () => { try { readFileSync(`/proc/${SOAK}/status`); return true; } catch { return false; } };
function tick() {
  if (!alive()) process.exit(0);
  const ts = Date.now();
  for (const d of readdirSync('/proc')) {
    if (!/^\d+$/.test(d)) continue;
    let cmd;
    try { cmd = readFileSync(`/proc/${d}/cmdline`, 'utf8').split('\0'); } catch { continue; }
    const c = cmd.find((a) => a.endsWith('/dist/cli.js'));
    if (!c || (cli && c !== cli) || !cmd.includes('start')) continue;
    const m = /gw-(\w+)\.yml$/.exec(cmd[cmd.indexOf('-c') + 1] ?? '');
    if (!m) continue;
    try {
      const st = readFileSync(`/proc/${d}/status`, 'utf8');
      const ppid = Number(/PPid:\s+(\d+)/.exec(st)?.[1]);
      if (String(ppid) !== String(SOAK)) continue; // only this soak's gateways
      const rss = Number(/VmRSS:\s+(\d+) kB/.exec(st)?.[1] ?? NaN) / 1024;
      appendFileSync(OUT, JSON.stringify({ ts, inst: m[1], pid: Number(d), rssMb: +rss.toFixed(1) }) + '\n');
    } catch { /* exited */ }
  }
}
tick();
setInterval(tick, EVERY);
