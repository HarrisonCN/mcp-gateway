/**
 * Anomaly detection (6.6): abuse and prompt-injection signals on live traffic.
 *
 * Per client, the detector keeps one-minute buckets and flags:
 *
 * - **burst** — calls in the current minute exceed `burst.factor` × the client's EWMA baseline (and `burst.min`);
 * - **error-spike** — error ratio over the last `windowMinutes` above `errors.ratio` (with ≥ `errors.min` calls);
 * - **enumeration** — more than `enumeration.distinctTools` distinct tools within `windowMinutes` (tool scanning);
 * - **prompt-injection** — arguments or results whose injection score reaches `injection.threshold`. The score adds
 *   weights of matched signals (instruction override, fake role tags, prompt exfiltration, tool hijacking, exfil
 *   URLs, hidden Unicode, long base64 blobs) and is capped at 1.
 *
 * `action: alert` only records; `action: quarantine` also refuses the client's calls (`-32015`) for
 * `quarantineSeconds` after an abuse alert, and refuses calls whose arguments score as injection.
 *
 * ```yaml
 * anomaly:
 *   action: quarantine
 *   quarantineSeconds: 300
 *   burst: { factor: 5, min: 30 }
 *   injection: { threshold: 0.6, scan: both }
 * ```
 *
 * - `GET  /admin/anomaly` — alerts (newest first), quarantined clients, per-client baselines.
 * - `POST /admin/anomaly/score` — `{ text | value }` → injection score and signals.
 * - `POST /admin/anomaly/release` — `{ client }` lifts a quarantine.
 *
 * @module features/anomaly
 */

import { z } from 'zod';
import { registerFeature, objectBody, badRequest } from '../gateway/features.js';
import { registerCallHook } from '../gateway/hooks.js';
import { BUILTIN_INJECTION_PATTERNS } from '../policy/output-filter.js';
import { POLICY_ERROR_CODES } from '../gateway/invoker.js';
import { globToRegExp } from '../utils/tool-filter.js';
import type { GatewayConfig } from '../utils/types.js';
import { type AnomalyConfig, AnomalySchema, ERR_ANOMALY_QUARANTINED } from './schemas/anomaly.js';
export { type AnomalyConfig, AnomalySchema, ERR_ANOMALY_QUARANTINED } from './schemas/anomaly.js';
type Cfg = z.output<typeof AnomalySchema>;

const WEIGHTS: Record<string, number> = {
  'ignore-instructions': 0.6,
  'new-instructions': 0.4,
  'role-override': 0.6,
  'fake-role-tags': 0.4,
  'prompt-exfiltration': 0.5,
  'tool-hijack': 0.7,
  'exfil-url': 0.7,
  'hidden-unicode': 0.5,
  'base64-blob': 0.2,
};
const PATTERNS: Array<[string, RegExp]> = [...Object.entries(BUILTIN_INJECTION_PATTERNS).map(([k, p]) => [k, new RegExp(p, 'iu')] as [string, RegExp]), ['base64-blob', /[A-Za-z0-9+/]{200,}={0,2}/]];

const strings = (v: unknown, out: string[] = [], depth = 0): string[] => {
  if (depth > 20) return out;
  if (typeof v === 'string') out.push(v);
  else if (Array.isArray(v)) for (const x of v) strings(x, out, depth + 1);
  else if (v && typeof v === 'object') for (const x of Object.values(v)) strings(x, out, depth + 1);
  return out;
};

/** Injection score 0..1 with the matched signals. */
export function injectionScore(value: unknown): { score: number; signals: string[] } {
  const text = strings(value).join('\n');
  const signals = PATTERNS.filter(([, re]) => re.test(text)).map(([k]) => k);
  return { score: Math.min(1, Math.round(signals.reduce((s, k) => s + (WEIGHTS[k] ?? 0.3), 0) * 100) / 100), signals };
}

export interface AnomalyAlert {
  timestamp: string;
  client: string;
  kind: 'burst' | 'error-spike' | 'enumeration' | 'prompt-injection';
  detail: string;
  serverId?: string;
  tool?: string;
  score?: number;
}

interface Bucket {
  minute: number;
  calls: number;
  errors: number;
  tools: Set<string>;
}
interface ClientState {
  buckets: Bucket[];
  baseline: number; // EWMA of completed-minute call counts
  minutes: number;
  flagged: Set<string>; // `${kind}@${minute}` to alert once per minute
}

export class AnomalyDetector {
  readonly clients = new Map<string, ClientState>();
  readonly alerts: AnomalyAlert[] = [];
  readonly quarantined = new Map<string, number>(); // client → until (ms)
  constructor(private readonly now: () => number = Date.now, private readonly maxAlerts = 500) {}

  private state(client: string): ClientState {
    let s = this.clients.get(client);
    if (!s) this.clients.set(client, (s = { buckets: [], baseline: 0, minutes: 0, flagged: new Set() }));
    return s;
  }

  private alert(cfg: Cfg, a: Omit<AnomalyAlert, 'timestamp'>, abuse: boolean): AnomalyAlert {
    const full = { timestamp: new Date(this.now()).toISOString(), ...a };
    this.alerts.push(full);
    if (this.alerts.length > this.maxAlerts) this.alerts.shift();
    if (abuse && cfg.action === 'quarantine') this.quarantined.set(a.client, this.now() + cfg.quarantineSeconds * 1000);
    return full;
  }

  isQuarantined(client: string): boolean {
    const until = this.quarantined.get(client);
    if (until === undefined) return false;
    if (until <= this.now()) {
      this.quarantined.delete(client);
      return false;
    }
    return true;
  }

  release(client: string): boolean {
    return this.quarantined.delete(client);
  }

  /** Record one finished call; returns the alerts it raised. */
  observe(cfg: Cfg, client: string, tool: string, ok: boolean): AnomalyAlert[] {
    const s = this.state(client);
    const minute = Math.floor(this.now() / 60_000);
    let cur = s.buckets.at(-1);
    if (!cur || cur.minute !== minute) {
      // close finished minutes into the baseline (idle minutes count as 0)
      if (cur) {
        const gap = Math.min(minute - cur.minute, 60);
        for (let i = 0; i < gap; i++) {
          const n = i === 0 ? cur.calls : 0;
          s.baseline = s.minutes === 0 ? n : s.baseline * 0.7 + n * 0.3;
          s.minutes++;
        }
      }
      s.buckets.push((cur = { minute, calls: 0, errors: 0, tools: new Set() }));
      s.buckets = s.buckets.filter((b) => b.minute > minute - cfg.windowMinutes);
      s.flagged = new Set([...s.flagged].filter((f) => f.endsWith(`@${minute}`)));
    }
    cur.calls++;
    if (!ok) cur.errors++;
    cur.tools.add(tool);
    const out: AnomalyAlert[] = [];
    const once = (kind: AnomalyAlert['kind'], detail: string) => {
      const k = `${kind}@${minute}`;
      if (s.flagged.has(k)) return;
      s.flagged.add(k);
      out.push(this.alert(cfg, { client, kind, detail }, true));
    };
    const expected = Math.max(s.baseline * cfg.burst.factor, cfg.burst.min);
    if (cur.calls > expected) once('burst', `${cur.calls} calls this minute (baseline ${s.baseline.toFixed(1)}/min)`);
    const calls = s.buckets.reduce((n, b) => n + b.calls, 0);
    const errors = s.buckets.reduce((n, b) => n + b.errors, 0);
    if (calls >= cfg.errors.min && errors / calls > cfg.errors.ratio) once('error-spike', `${errors}/${calls} calls failed in ${cfg.windowMinutes} min`);
    const distinct = new Set(s.buckets.flatMap((b) => [...b.tools])).size;
    if (distinct > cfg.enumeration.distinctTools) once('enumeration', `${distinct} distinct tools in ${cfg.windowMinutes} min`);
    return out;
  }

  /** Score a payload; records an alert at or above the threshold. */
  scan(cfg: Cfg, client: string, serverId: string, tool: string, value: unknown, where: 'arguments' | 'results'): { score: number; signals: string[]; alert?: AnomalyAlert } {
    const r = injectionScore(value);
    if (r.score < cfg.injection.threshold) return r;
    return { ...r, alert: this.alert(cfg, { client, kind: 'prompt-injection', detail: `${where}: ${r.signals.join(', ')}`, serverId, tool, score: r.score }, false) };
  }

  baselines() {
    return [...this.clients].map(([client, s]) => ({ client, baselinePerMinute: Math.round(s.baseline * 10) / 10, windowCalls: s.buckets.reduce((n, b) => n + b.calls, 0), windowErrors: s.buckets.reduce((n, b) => n + b.errors, 0) }));
  }
}

export const anomalyDetector = new AnomalyDetector();

const settings = (cfg: GatewayConfig): Cfg | undefined => {
  if (!cfg.anomaly) return undefined;
  const c = AnomalySchema.parse(cfg.anomaly);
  return c.enabled ? c : undefined;
};
const exempt = (c: Cfg, client: string) => c.exempt.some((g) => globToRegExp(g).test(client));

registerCallHook({
  id: 'anomaly',
  before: (call, cfg) => {
    const c = settings(cfg);
    if (!c) return;
    const client = call.clientId ?? 'anonymous';
    if (exempt(c, client)) return;
    if (c.action === 'quarantine' && anomalyDetector.isQuarantined(client)) {
      return { refuse: { code: ERR_ANOMALY_QUARANTINED, message: `Client ${client} is quarantined after anomalous activity`, data: { decision: 'anomaly' } } };
    }
    if (c.injection.scan === 'arguments' || c.injection.scan === 'both') {
      const r = anomalyDetector.scan(c, client, call.serverId, call.tool, call.args, 'arguments');
      if (r.alert && c.action === 'quarantine') return { refuse: { code: ERR_ANOMALY_QUARANTINED, message: `Possible prompt injection in the arguments (${r.signals.join(', ')})`, data: { decision: 'anomaly', score: r.score, signals: r.signals } } };
    }
  },
  after: (call, result, cfg) => {
    const c = settings(cfg);
    if (!c) return;
    const client = call.clientId ?? 'anonymous';
    if (exempt(c, client)) return;
    anomalyDetector.observe(c, client, `${call.serverId}/${call.tool}`, result.success);
    if (result.success && (c.injection.scan === 'results' || c.injection.scan === 'both')) anomalyDetector.scan(c, client, call.serverId, call.tool, result.result, 'results');
  },
});

registerFeature({
  id: 'anomaly',
  since: '6.6.0',
  summary: 'Anomaly detection: traffic bursts, error spikes, tool enumeration and prompt-injection scoring with alert / quarantine',
  mount: (router, ctx) => {
    router.get('/', (req, res) => {
      const c = settings(ctx.config());
      const kind = typeof req.query.kind === 'string' ? req.query.kind : undefined;
      const quarantined = [...anomalyDetector.quarantined.keys()].filter((k) => anomalyDetector.isQuarantined(k)).map((client) => ({ client, until: new Date(anomalyDetector.quarantined.get(client)!).toISOString() }));
      res.json({ enabled: !!c, action: c?.action ?? null, alerts: anomalyDetector.alerts.filter((a) => !kind || a.kind === kind).slice(-100).reverse(), quarantined, clients: anomalyDetector.baselines() });
    });
    router.post('/score', (req, res) => {
      const b = objectBody(req, res);
      if (!b) return;
      const v = b.text ?? b.value;
      if (v === undefined) return badRequest(res, '"text" or "value" is required');
      const r = injectionScore(v);
      res.json({ ...r, threshold: settings(ctx.config())?.injection.threshold ?? 0.6 });
    });
    router.post('/release', (req, res) => {
      const b = objectBody(req, res);
      if (!b) return;
      if (typeof b.client !== 'string') return badRequest(res, '"client" is required');
      res.json({ client: b.client, released: anomalyDetector.release(b.client) });
    });
  },
});
