/**
 * Revocation notices (14.5.0): the core tells interested modules that a credential was revoked locally (today: a
 * developer-portal key revoked by its holder or an operator). The `regions` module turns a notice into a replicated
 * revocation so every region refuses the client id within its bounded staleness.
 *
 * Listeners are kept per gateway instance (see kernel/instance), so two gateways in one process never see each
 * other's notices.
 *
 * @module gateway/revocations
 */

import { instanceLocal } from '../kernel/instance.js';

export type RevocationListener = (clientId: string, reason?: string) => void;

const listeners = instanceLocal('core', 'revocation-listeners', () => new Set<RevocationListener>());

/** Subscribe to local revocations; returns the unsubscribe function. */
export function onRevocation(fn: RevocationListener): () => void {
  const set = listeners;
  set.add(fn);
  return () => void set.delete(fn);
}

/** Announce that `clientId` was revoked on this gateway. Listener errors never fail the revocation itself. */
export function announceRevocation(clientId: string, reason?: string): void {
  for (const fn of [...listeners]) {
    try {
      fn(clientId, reason);
    } catch {
      /* a listener must not break the caller */
    }
  }
}

// ─── 14.6.0: revocation authorities ──────────────────────────────────────────────────────────────────────────────

/**
 * A module that knows revocations beyond the local key set (today: `regions`, replicated revocations). Work that
 * acts later for a caller — the edge outbox replaying queued calls on reconnect — asks the authorities before it acts.
 */
export interface RevocationAuthority {
  /** Whether `clientId` is revoked as far as this authority knows now. */
  isRevoked(clientId: string): boolean;
  /**
   * Bring this authority up to date now (e.g. one sync round with every peer) and say whether its revocations are
   * fresh — learned after `since` (ms epoch) from every source. Not fresh = a revocation may still be unknown.
   */
  confirm(since: number): Promise<{ fresh: boolean; detail?: string }>;
}

const authorities = instanceLocal('core', 'revocation-authorities', () => new Map<string, RevocationAuthority>());

/** Register (or replace) the authority `id`; returns the unregister function. */
export function registerRevocationAuthority(id: string, a: RevocationAuthority): () => void {
  const map = authorities;
  map.set(id, a);
  return () => {
    if (map.get(id) === a) map.delete(id);
  };
}

/** The first authority that reports any of `ids` revoked, else undefined. */
export function revokedBy(ids: Array<string | undefined>): string | undefined {
  for (const [name, a] of authorities) {
    for (const id of ids) {
      if (!id) continue;
      try {
        if (a.isRevoked(id)) return name;
      } catch {
        return name; // an authority that cannot answer counts as "revoked" (fail closed)
      }
    }
  }
  return undefined;
}

/** Ask every authority to confirm its revocations are fresh since `since`. No authorities = fresh. */
export async function confirmRevocations(since: number): Promise<{ fresh: boolean; detail?: string }> {
  for (const [name, a] of [...authorities]) {
    try {
      const r = await a.confirm(since);
      if (!r.fresh) return { fresh: false, detail: `${name}: ${r.detail ?? 'revocations not confirmed fresh'}` };
    } catch (e) {
      return { fresh: false, detail: `${name}: ${(e as Error).message}` };
    }
  }
  return { fresh: true };
}
