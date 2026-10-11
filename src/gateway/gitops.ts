/**
 * GitOps routes (14.7.0), operators only, under `/api/v1/admin/gitops` — active when `controlPlane.gitops` is set:
 *
 * - `GET  /admin/gitops/status` — environment, enforcement, the release applied last (git sha, author, approvers),
 *   drift between that release and the running config (paths), recent gitops events.
 * - `POST /admin/gitops/plan` `{ bundle, manifest?, calls?, source? }` — what applying the bundle would change
 *   (structural diff against the running config), whether the manifest verifies and the bundle would be accepted, and
 *   a policy simulation: recorded calls (or `calls`) replayed against the candidate, with every changed decision explained.
 * - `POST /admin/gitops/apply` `{ bundle, manifest?, dryRun? }` — verify and hot-apply. With `enforce: true` an unsigned
 *   or insufficiently approved bundle is refused (403), and so are the unmanaged config paths (`PUT /admin/config`,
 *   `POST /admin/reload`, feature `applyConfig`). On a control plane the applied config is published as the next
 *   config generation and rolls out to data planes as configured in `controlPlane.rollout` (14.1).
 *
 * Every apply, refusal and drift transition is an audit entry (server `_gitops`, tool `gitops.apply` / `gitops.drift`,
 * `decision`) and is counted in `mcp_gateway_gitops_*` metrics.
 *
 * @module gateway/gitops
 */

import express, { type Request, type RequestHandler, type Response } from 'express';
import { existsSync, readFileSync, writeFileSync, mkdirSync, renameSync } from 'fs';
import { dirname, resolve } from 'path';
import type { GatewayConfig, RequestMetric } from '../utils/types.js';
import { REDACTED, diffConfigs, type ConfigChange } from '../config/diff.js';
import { GitopsSchema, BUNDLE_SCHEMA, configHash, findSecretLiterals, requiredApprovalsFor, simulateRelease, verifyRelease, type GitopsBundle, type ReleaseManifest, type SimulatedCall, type VerifyResult } from '../config/gitops.js';
import { diffAgainst, normalizedConfig, portableConfig, prepareConfig } from './admin.js';
import { clientIdOf } from './features.js';
import { registerMetricSource } from '../monitor/index.js';
import { logger } from '../utils/logger.js';
import type { CapturedCall } from './replay.js';

export interface GitopsDeps {
  config: () => GatewayConfig;
  apply: (next: GatewayConfig) => Promise<void>;
  authenticate: RequestHandler;
  isOperator: (req: Request) => boolean;
  /** Audit entry (request metrics / audit store). */
  record: (m: Omit<RequestMetric, 'id' | 'timestamp'>) => void;
  capturedCalls?: () => CapturedCall[];
  recent?: (limit?: number) => RequestMetric[];
  now?: () => number;
}

export interface AppliedRelease {
  env: string;
  configHash: string;
  signed: boolean;
  gitSha?: string;
  author?: string;
  approvers: string[];
  createdAt?: string;
  appliedAt: string;
  appliedBy?: string;
}

interface GitopsEvent {
  at: string;
  action: 'apply' | 'drift' | 'drift-resolved';
  result: string;
  reason?: string;
  gitSha?: string;
  configHash?: string;
  by?: string;
}

const MAX_HISTORY = 100;

const hasRedacted = (v: unknown): boolean => (v === REDACTED ? true : Array.isArray(v) ? v.some(hasRedacted) : v && typeof v === 'object' ? Object.values(v).some(hasRedacted) : false);

class BadRequest extends Error {}

/** `/api/v1/admin/gitops/*` plus drift detection and metrics. `stop()` clears the drift timer. */
export function createGitopsRouter(deps: GitopsDeps): express.Router & { stop: () => void } {
  const router = express.Router() as express.Router & { stop: () => void };
  const now = deps.now ?? Date.now;
  const operator: RequestHandler = (req, res, next) =>
    deps.isOperator(req) ? next() : void res.status(403).json({ error: 'Forbidden', message: 'The admin API is for operators (unscoped keys)' });
  const guard = [deps.authenticate, operator];

  let release: AppliedRelease | null = null;
  let snapshot: { hash: string; config?: Record<string, unknown> } | null = null;
  let drift = { drifted: false, changes: [] as ConfigChange[], checkedAt: undefined as string | undefined };
  const history: GitopsEvent[] = [];
  const counters = { applied: 0, refused: 0, dry_run: 0, invalid: 0 };
  let lastApplyAt = 0;
  let queue: Promise<unknown> = Promise.resolve();

  const trust = () => {
    const raw = deps.config().controlPlane?.gitops;
    if (!raw) return undefined;
    const p = GitopsSchema.safeParse(raw);
    return p.success ? p.data : undefined;
  };
  const recordFile = () => {
    const f = trust()?.recordFile;
    return f ? resolve(deps.config().configDir ?? process.cwd(), f) : undefined;
  };
  const event = (e: Omit<GitopsEvent, 'at'>) => {
    history.push({ at: new Date(now()).toISOString(), ...e });
    if (history.length > MAX_HISTORY) history.shift();
  };
  const audit = (tool: string, decision: string, success: boolean, by?: string, reason?: string, durationMs = 0) =>
    deps.record({ serverId: '_gitops', toolName: tool, durationMs, success, decision, ...(reason ? { errorMessage: reason.slice(0, 500) } : {}), clientId: by ?? 'gitops' });

  // A release record survives restarts when `recordFile` is set (replay protection, drift baseline).
  try {
    const f = recordFile();
    if (f && existsSync(f)) {
      const saved = JSON.parse(readFileSync(f, 'utf8')) as { release?: AppliedRelease; hash?: string };
      if (saved.release && typeof saved.hash === 'string') {
        release = saved.release;
        snapshot = { hash: saved.hash };
      }
    }
  } catch (err) {
    logger.warn(`gitops: cannot read the release record: ${err instanceof Error ? err.message : String(err)}`);
  }
  const persist = () => {
    const f = recordFile();
    if (!f || !release || !snapshot) return;
    try {
      mkdirSync(dirname(f), { recursive: true, mode: 0o700 });
      writeFileSync(`${f}.tmp`, JSON.stringify({ release, hash: snapshot.hash }, null, 2), { mode: 0o600 });
      renameSync(`${f}.tmp`, f);
    } catch (err) {
      logger.warn(`gitops: cannot write the release record: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  /** Compare the running config with the applied release; audits transitions. */
  const checkDrift = () => {
    if (!snapshot || !trust()) return drift;
    const live = normalizedConfig(deps.config());
    const drifted = configHash(live) !== snapshot.hash;
    const changes = drifted && snapshot.config ? diffConfigs(snapshot.config as never, live as never) : [];
    if (drifted && !drift.drifted) {
      const paths = changes.map((c) => c.path).join(', ') || 'unknown paths (baseline from the release record)';
      logger.warn(`gitops: the running config drifted from release ${release?.gitSha ?? release?.configHash ?? ''}: ${paths}`);
      event({ action: 'drift', result: 'drift', reason: paths, gitSha: release?.gitSha, configHash: release?.configHash });
      audit('gitops.drift', 'drift', false, 'gitops', `drift from ${release?.gitSha ?? release?.configHash}: ${paths}`);
    } else if (!drifted && drift.drifted) {
      event({ action: 'drift-resolved', result: 'in-sync', gitSha: release?.gitSha });
      audit('gitops.drift', 'in-sync', true);
    }
    drift = { drifted, changes, checkedAt: new Date(now()).toISOString() };
    return drift;
  };

  let timer: NodeJS.Timeout | undefined;
  let timerMs = 0;
  const schedule = () => {
    const ms = trust()?.driftCheckIntervalMs ?? 0;
    if (ms === timerMs) return;
    if (timer) clearInterval(timer);
    timer = undefined;
    timerMs = ms;
    if (ms > 0) {
      timer = setInterval(() => {
        try {
          checkDrift();
          schedule();
        } catch (err) {
          logger.debug(`gitops drift check: ${String(err)}`);
        }
      }, ms);
      timer.unref?.();
    }
  };
  schedule();
  router.stop = () => {
    if (timer) clearInterval(timer);
    timer = undefined;
  };

  registerMetricSource('gitops', () => {
    if (!trust()) return [];
    const d = checkDrift();
    const out = [
      '# HELP mcp_gateway_gitops_applies_total GitOps apply requests by result.',
      '# TYPE mcp_gateway_gitops_applies_total counter',
      ...Object.entries(counters).map(([k, v]) => `mcp_gateway_gitops_applies_total{result="${k}"} ${v}`),
      '# HELP mcp_gateway_gitops_drift 1 when the running config differs from the release applied last.',
      '# TYPE mcp_gateway_gitops_drift gauge',
      `mcp_gateway_gitops_drift ${d.drifted ? 1 : 0}`,
      '# HELP mcp_gateway_gitops_enforced 1 when only signed, approved releases may change the config.',
      '# TYPE mcp_gateway_gitops_enforced gauge',
      `mcp_gateway_gitops_enforced ${trust()?.enforce ? 1 : 0}`,
    ];
    if (release) {
      const esc = (s: string) => s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, ' ');
      out.push(
        '# HELP mcp_gateway_gitops_release_info The release applied last.',
        '# TYPE mcp_gateway_gitops_release_info gauge',
        `mcp_gateway_gitops_release_info{env="${esc(release.env)}",git_sha="${esc(release.gitSha ?? '')}"} 1`,
        '# HELP mcp_gateway_gitops_last_apply_timestamp_seconds When the release was applied.',
        '# TYPE mcp_gateway_gitops_last_apply_timestamp_seconds gauge',
        `mcp_gateway_gitops_last_apply_timestamp_seconds ${Math.floor((lastApplyAt || Date.parse(release.appliedAt)) / 1000)}`,
      );
    }
    return out;
  });

  /** Validate the body's bundle and turn it into a runnable config. Throws BadRequest. */
  const readBundle = async (b: Record<string, unknown>, t: NonNullable<ReturnType<typeof trust>>): Promise<{ bundle: GitopsBundle; next: GatewayConfig }> => {
    const bundle = b.bundle as GitopsBundle | undefined;
    if (!bundle || typeof bundle !== 'object' || Array.isArray(bundle)) throw new BadRequest('"bundle" is required (render it with `mcp-gateway gitops render`)');
    if (bundle.schema !== undefined && bundle.schema !== BUNDLE_SCHEMA) throw new BadRequest(`bundle.schema must be ${BUNDLE_SCHEMA}`);
    if (typeof bundle.env !== 'string' || !bundle.config || typeof bundle.config !== 'object' || Array.isArray(bundle.config)) throw new BadRequest('bundle needs "env" and "config"');
    if (bundle.env !== t.environment) throw new BadRequest(`the bundle is for environment "${bundle.env}", this gateway is "${t.environment}"`);
    if (bundle.configHash !== undefined && bundle.configHash !== configHash(bundle.config)) throw new BadRequest('bundle.configHash does not match bundle.config');
    if (hasRedacted(bundle.config)) throw new BadRequest(`bundle.config contains "${REDACTED}" placeholders — a release carries the whole config (secrets as references)`);
    const literals = findSecretLiterals(bundle.config);
    if (literals.length) throw new BadRequest(`secrets must be references (\${ENV_VAR} or secret://…), literal secret at: ${literals.join(', ')}`);
    const pol = (bundle.config as { policy?: { files?: unknown[] } }).policy;
    if (pol?.files?.length) throw new BadRequest('policy.files must be inlined into the bundle (mcp-gateway gitops render does that)');
    try {
      const next = await prepareConfig(JSON.parse(JSON.stringify(bundle.config)) as Record<string, unknown>, deps.config());
      return { bundle, next };
    } catch (err) {
      throw new BadRequest(err instanceof Error ? err.message : String(err));
    }
  };

  const lastApplied = () => (release?.signed && release.createdAt ? { createdAt: release.createdAt, configHash: release.configHash } : undefined);

  /** Why this bundle / manifest may not be applied (undefined: it may). */
  const refusalOf = (t: NonNullable<ReturnType<typeof trust>>, manifest: unknown, v: VerifyResult | null): string | undefined => {
    if (manifest === undefined || manifest === null) return t.enforce ? 'unsigned bundle: gitops enforcement requires a signed, approved release manifest' : undefined;
    if (v && !v.ok) return `release manifest refused: ${v.reasons.join('; ')}`;
    return undefined;
  };

  /**
   * Verify the release manifest (always run, so no request field decides whether verification happens) and
   * derive the refusal. A missing manifest verifies as "not a release manifest" and is reported as unsigned.
   */
  const assess = (t: NonNullable<ReturnType<typeof trust>>, manifest: unknown, bundle: Pick<GitopsBundle, 'env' | 'config'>): { v: VerifyResult | null; refusal: string | undefined } => {
    const checked = verifyRelease(manifest as ReleaseManifest, bundle, t, { now: now(), lastApplied: lastApplied() });
    const unsigned = manifest === undefined || manifest === null;
    const v = unsigned ? null : checked;
    return { v, refusal: refusalOf(t, manifest, v) };
  };

  const callsFor = (b: Record<string, unknown>): { calls: SimulatedCall[]; source: string } => {
    if (Array.isArray(b.calls)) {
      if (!b.calls.every((c) => c && typeof c === 'object' && typeof (c as SimulatedCall).serverId === 'string' && typeof (c as SimulatedCall).tool === 'string')) throw new BadRequest('each call needs serverId and tool');
      return { calls: (b.calls as SimulatedCall[]).slice(0, 10_000), source: 'request' };
    }
    const captured = (deps.capturedCalls?.() ?? []).filter((c) => c.kind === 'tool');
    if (captured.length && b.source !== 'metrics') return { calls: captured.map((c) => ({ clientId: c.clientId, serverId: c.serverId, tool: c.tool, args: c.arguments ?? {} })), source: 'replay' };
    const recent = (deps.recent?.(Number(b.limit) || 1000) ?? []).filter((m) => (m.kind ?? 'tool') === 'tool' && !m.serverId.startsWith('_'));
    return { calls: recent.map((m) => ({ clientId: m.clientId, serverId: m.serverId, tool: m.toolName })), source: 'metrics' };
  };

  const body = (req: Request, res: Response): Record<string, unknown> | undefined => {
    const b = req.body;
    if (!b || typeof b !== 'object' || Array.isArray(b)) {
      res.status(400).json({ error: 'Bad Request', message: 'Body must be a JSON object' });
      return undefined;
    }
    return b as Record<string, unknown>;
  };
  const notConfigured = (res: Response) => res.status(409).json({ error: 'Conflict', message: 'GitOps is not configured (controlPlane.gitops)' });

  router.get('/admin/gitops/status', ...guard, (_req, res) => {
    const t = trust();
    if (!t) return void res.set('Cache-Control', 'no-store').json({ configured: false, message: 'GitOps is not configured (controlPlane.gitops)' });
    schedule();
    const d = checkDrift();
    res.set('Cache-Control', 'no-store').json({
      configured: true,
      environment: t.environment,
      enforce: t.enforce,
      requiredApprovals: requiredApprovalsFor(t, t.environment),
      trustedKeys: t.trustedKeys.map((k) => ({ id: k.id, name: k.name, roles: k.roles })),
      managed: !!release,
      release,
      live: { configHash: configHash(normalizedConfig(deps.config())) },
      drift: release ? { drifted: d.drifted, changes: d.changes, checkedAt: d.checkedAt } : { drifted: false, changes: [], reason: 'no release applied yet' },
      history: [...history].reverse(),
    });
  });

  router.post('/admin/gitops/plan', ...guard, async (req, res, next) => {
    const t = trust();
    if (!t) return void notConfigured(res);
    const b = body(req, res);
    if (!b) return;
    try {
      const { bundle, next: cfg } = await readBundle(b, t);
      const current = deps.config();
      const changes = diffAgainst(current, cfg);
      const { v, refusal } = assess(t, b.manifest, bundle);
      const { calls, source } = callsFor(b);
      const simulation = simulateRelease(portableConfig(current), portableConfig(cfg), calls, { source });
      res.json({
        environment: t.environment,
        enforce: t.enforce,
        configHash: configHash(bundle.config),
        changes,
        restart: changes.filter((c) => c.restart).map((c) => c.path),
        verification: v,
        wouldApply: !refusal,
        ...(refusal ? { refusal } : {}),
        simulation,
        current: release ? { gitSha: release.gitSha, configHash: release.configHash } : null,
      });
    } catch (err) {
      if (err instanceof BadRequest) return void res.status(400).json({ error: 'Bad Request', message: err.message });
      next(err);
    }
  });

  router.post('/admin/gitops/apply', ...guard, (req, res, next) => {
    const t = trust();
    if (!t) return void notConfigured(res);
    const b = body(req, res);
    if (!b) return;
    const by = clientIdOf(req);
    const started = now();
    // one apply at a time: verification (replay check) and the apply see the same release state
    const run = queue.then(async () => {
      try {
        const { bundle, next: cfg } = await readBundle(b, t);
        const { v, refusal } = assess(t, b.manifest, bundle);
        const m = b.manifest as ReleaseManifest | undefined;
        if (refusal) {
          counters.refused++;
          event({ action: 'apply', result: 'refused', reason: refusal, gitSha: m?.gitSha, configHash: configHash(bundle.config), by });
          audit('gitops.apply', 'refused', false, by, refusal, now() - started);
          logger.warn(`gitops: apply refused (${by ?? 'unknown'}): ${refusal}`);
          return void res.status(403).json({ error: 'Forbidden', reason: refusal, verification: v });
        }
        const current = deps.config();
        const changes = diffAgainst(current, cfg);
        if (b.dryRun === true) {
          counters.dry_run++;
          return void res.json({ applied: false, dryRun: true, changes, verification: v });
        }
        if (changes.length > 0) await deps.apply(cfg);
        release = {
          env: bundle.env,
          configHash: configHash(bundle.config),
          signed: !!v?.ok,
          ...(m && v?.ok ? { gitSha: m.gitSha, author: v.author ?? m.author, createdAt: m.createdAt } : {}),
          approvers: v?.ok ? v.approvers : [],
          appliedAt: new Date(now()).toISOString(),
          ...(by ? { appliedBy: by } : {}),
        };
        const live = normalizedConfig(deps.config());
        snapshot = { hash: configHash(live), config: live };
        drift = { drifted: false, changes: [], checkedAt: new Date(now()).toISOString() };
        lastApplyAt = now();
        counters.applied++;
        persist();
        event({ action: 'apply', result: 'applied', gitSha: release.gitSha, configHash: release.configHash, by, ...(release.signed ? {} : { reason: 'unsigned (enforcement off)' }) });
        audit('gitops.apply', 'applied', true, by, release.signed ? `release ${release.gitSha} by ${release.author}, approved by ${release.approvers.join(', ') || 'nobody (none required)'}` : 'unsigned bundle (enforcement off)', now() - started);
        logger.info(`gitops: applied ${release.signed ? `release ${release.gitSha} (${release.author}; approvers ${release.approvers.join(', ') || '-'})` : 'an unsigned bundle'} — ${changes.length} change(s)`);
        res.json({ applied: changes.length > 0, changes, release, verification: v });
      } catch (err) {
        if (err instanceof BadRequest) {
          counters.invalid++;
          return void res.status(400).json({ error: 'Bad Request', message: err.message });
        }
        next(err);
      }
    });
    queue = run.catch(() => undefined);
  });

  return router;
}
