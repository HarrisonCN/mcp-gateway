/**
 * Final call security snapshot (13.1.3).
 *
 * After the final authorization the invoker freezes what was approved: the principal (and the subject a delegated
 * call is made for), the upstream server the call goes to, the tool, the business arguments every security check saw,
 * and the server whose injected credentials may be added (the credential target). The upstream send compares the call
 * it is about to make with the snapshot and refuses anything that differs, so nothing between the last check and the
 * wire (a hook, a cache wrapper, a future pipeline stage) can change the target, the arguments or whose credentials
 * travel with the call.
 *
 * @module gateway/final-call
 */

import { createHash } from 'crypto';
import type { CallKind } from './invoker.js';

export type FinalCallSnapshot = Readonly<{
  /** Principal id the call was authorized for. */
  principal: string;
  /** Subject (original caller) of the call (13.1.2). */
  subject?: string;
  /** Agent hops of a delegated call, outermost first. */
  actors: readonly string[];
  /** Upstream server the call is sent to (after reroutes and routing splits). */
  serverId: string;
  /** Server the caller asked for. */
  requestedServer: string;
  tool: string;
  kind: CallKind;
  /** Business arguments as approved (deep-frozen copy; injected credentials are not part of it). */
  args: Readonly<Record<string, unknown>>;
  /** Digest of `args` (canonical JSON, sha256). */
  argsDigest: string;
  /** The only server whose `inject:` credentials may be added to the call: always `serverId`. */
  credentialTarget: string;
  /**
   * 13.2.0: config generation the call was authorized in. Server config, credentials, session, policy and plugins of
   * the call all come from it; the send is refused when the call is no longer running in it.
   */
  generation?: number;
}>;

/** Canonical JSON (object keys sorted, recursively) — stable across key order. */
export function canonicalJson(v: unknown): string {
  const seen = new WeakSet<object>();
  const walk = (x: unknown): unknown => {
    if (x === undefined) return null;
    if (!x || typeof x !== 'object') return x;
    if (seen.has(x as object)) return '[circular]';
    seen.add(x as object);
    if (Array.isArray(x)) return x.map(walk);
    const o = x as Record<string, unknown>;
    return Object.fromEntries(Object.keys(o).sort().filter((k) => o[k] !== undefined).map((k) => [k, walk(o[k])]));
  };
  return JSON.stringify(walk(v)) ?? 'null';
}

/** Digest of a call's arguments, optionally without some top-level keys (injected credentials). */
export function argsDigest(args: Record<string, unknown> | undefined, without: readonly string[] = []): string {
  const a = { ...(args ?? {}) };
  for (const k of without) delete a[k];
  return createHash('sha256').update(canonicalJson(a)).digest('hex');
}

function deepFreeze<T>(v: T): T {
  if (v && typeof v === 'object' && !Object.isFrozen(v)) {
    Object.freeze(v);
    for (const x of Object.values(v as Record<string, unknown>)) deepFreeze(x);
  }
  return v;
}

export function makeSnapshot(s: Omit<FinalCallSnapshot, 'args' | 'argsDigest' | 'credentialTarget'> & { args: Record<string, unknown> }): FinalCallSnapshot {
  let copy: Record<string, unknown>;
  try {
    copy = structuredClone(s.args ?? {});
  } catch {
    copy = JSON.parse(canonicalJson(s.args ?? {})) as Record<string, unknown>;
  }
  return Object.freeze({ ...s, actors: Object.freeze([...s.actors]), args: deepFreeze(copy), argsDigest: argsDigest(copy), credentialTarget: s.serverId });
}

/**
 * Why the call about to be sent differs from its snapshot (undefined = it matches). `injected` lists the argument names
 * the credential injection set and the server they came from.
 */
export function snapshotMismatch(
  snap: FinalCallSnapshot,
  call: { serverId: string; name: string; kind: CallKind; principal?: string; params: Record<string, unknown>; generation?: number },
  injected?: { target: string; arguments: readonly string[] },
): string | undefined {
  if (call.serverId !== snap.serverId || call.name !== snap.tool || call.kind !== snap.kind) return 'target-changed-after-authorization';
  if (snap.generation !== undefined && call.generation !== undefined && call.generation !== snap.generation) return 'config-generation-changed';
  if (call.principal !== undefined && call.principal !== snap.principal) return 'principal-changed-after-authorization';
  if (injected && injected.arguments.length && injected.target !== snap.credentialTarget) return 'credentials-of-another-server';
  const keys = injected?.arguments ?? [];
  if (argsDigest(call.params, keys) !== argsDigest(snap.args as Record<string, unknown>, keys)) return 'arguments-changed-after-authorization';
  return undefined;
}
