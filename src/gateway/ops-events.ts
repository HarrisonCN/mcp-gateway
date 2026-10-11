/**
 * Operational events and status sources of the operations console (14.8.0). Kept dependency-free so the plugin host,
 * feature modules and the gateway can report without importing the console. Per gateway instance (kernel/instance).
 *
 * @module gateway/ops-events
 */

import { instanceLocal } from '../kernel/instance.js';
import { redactString } from '../security/redact.js';

export const TIMELINE_KINDS = ['restart', 'config-apply', 'gitops-release', 'revocation', 'circuit-open', 'region-stale', 'region-fresh', 'audit'] as const;
export type TimelineKind = (typeof TIMELINE_KINDS)[number];
export interface OpsEvent {
  at: string;
  kind: TimelineKind;
  severity: 'info' | 'warning' | 'error';
  subject?: string;
  detail: string;
  source: string;
}

export type OpsListener = (e: OpsEvent) => void;
export const opsListeners = instanceLocal('core', 'ops-event-listeners', () => new Set<OpsListener>());

/** Report an operational event (plugins, regions, the gateway); delivered to this gateway instance's timeline. */
export function emitOpsEvent(e: Omit<OpsEvent, 'at'> & { at?: string }): void {
  const ev: OpsEvent = { ...e, at: e.at ?? new Date().toISOString(), detail: redactString(String(e.detail).slice(0, 500)) };
  for (const fn of [...opsListeners]) {
    try {
      fn(ev);
    } catch {
      /* never break the emitter */
    }
  }
}

/** Status sources contributed by feature modules (`regions`, `dlq`), per gateway instance. */
export const opsSources = instanceLocal('core', 'ops-status-sources', () => new Map<string, () => unknown>());
export function registerOpsSource(id: string, fn: () => unknown): void {
  opsSources.set(id, fn);
}
