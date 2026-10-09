/**
 * DLP counters (13.0): process-wide finding counts, shared by the `dlp` feature module (writer) and the admin /
 * compliance views (readers) without the readers loading the module.
 *
 * @module policy/dlp-stats
 */

/** Findings by category / level / action since start. */
export const dlpStats = { calls: 0, byCategory: {} as Record<string, number>, byLevel: {} as Record<string, number>, byAction: {} as Record<string, number> };
export function countDlpFindings(findings: ReadonlyArray<{ category: string; level: string; action: string }>): void {
  dlpStats.calls++;
  for (const f of findings) {
    dlpStats.byCategory[f.category] = (dlpStats.byCategory[f.category] ?? 0) + 1;
    dlpStats.byLevel[f.level] = (dlpStats.byLevel[f.level] ?? 0) + 1;
    dlpStats.byAction[f.action] = (dlpStats.byAction[f.action] ?? 0) + 1;
  }
}
