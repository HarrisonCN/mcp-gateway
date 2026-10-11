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
