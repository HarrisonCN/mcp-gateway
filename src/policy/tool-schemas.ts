/**
 * 15.3.0-canary.0: tool schema governance (`policy.toolSchemas`).
 *
 * - **Output validation** — a tool result's `structuredContent` is checked against the tool's `outputSchema`
 *   (MCP 2025-06-18). `audit` passes it through and counts it; `enforce` refuses the call with -32005 so nothing of the
 *   invalid result reaches the client. Error results (`isError: true`) and tools without an `outputSchema` are not
 *   checked. A tool with an `outputSchema` that returns no `structuredContent` is a violation (the spec requires it).
 * - **Schema pins** — `pins: { "server/tool": "<sha256>" }` fixes the tool's `{ inputSchema, outputSchema }` (see
 *   {@link toolSchemaDigest}). When the upstream server changes the schema, calls are refused before they reach it
 *   (`onDrift: block`, default) or passed and reported (`onDrift: audit`).
 *
 * @module policy/tool-schemas
 */

import type { ToolInfo, ToolSchemasConfig } from '../utils/types.js';
import { globMatch } from '../utils/tool-filter.js';
import { toolSchemaDigest, validateJsonSchema, type SchemaError } from './json-schema.js';

export interface PinCheck {
  key: string;
  expected: string;
  /** Digest of the schema the server lists now; null when it no longer lists the tool. */
  actual: string | null;
  block: boolean;
}

export interface OutputCheck {
  key: string;
  errors: SchemaError[];
  enforce: boolean;
}

export interface ToolSchemaRow {
  server: string;
  tool: string;
  sha256: string;
  inputSchema: boolean;
  outputSchema: boolean;
  pinned: boolean;
  drift: boolean;
  /** Results that did not match the outputSchema (audit + enforce) since start. */
  violations: number;
  /** Calls let through despite a drifted pin (`onDrift: audit`) since start. */
  driftCalls: number;
  /** Calls refused because of a drifted pin since start. */
  driftRefusals: number;
}

const keyOf = (serverId: string, tool: string) => `${serverId}/${tool}`;

export class ToolSchemaGovernor {
  private readonly violations = new Map<string, number>();
  private readonly driftCalls = new Map<string, number>();
  private readonly driftRefusals = new Map<string, number>();
  private readonly digests = new WeakMap<object, string>();

  private bump(m: Map<string, number>, k: string): void {
    if (!m.has(k) && m.size >= 10_000) m.delete(m.keys().next().value as string); // bounded
    m.set(k, (m.get(k) ?? 0) + 1);
  }

  /** Digest of a tool's schemas (memoized per tool-list entry). */
  digest(info: ToolInfo): string {
    let d = this.digests.get(info);
    if (!d) {
      d = toolSchemaDigest(info);
      this.digests.set(info, d);
    }
    return d;
  }

  /** The pin of a call's tool, when it is pinned and the schema no longer matches. Counts the outcome. */
  checkPin(cfg: ToolSchemasConfig | undefined, serverId: string, tool: string, info: ToolInfo | undefined): PinCheck | undefined {
    const key = keyOf(serverId, tool);
    const expected = cfg?.pins?.[key];
    if (!expected) return undefined;
    const actual = info ? this.digest(info) : null;
    if (actual === expected) return undefined;
    const block = (cfg?.onDrift ?? 'block') === 'block';
    this.bump(block ? this.driftRefusals : this.driftCalls, key);
    return { key, expected, actual, block };
  }

  /** Validate a successful tool result against the tool's outputSchema. Counts violations. */
  checkOutput(cfg: ToolSchemasConfig | undefined, serverId: string, tool: string, info: ToolInfo | undefined, result: unknown): OutputCheck | undefined {
    const mode = cfg?.validateOutput ?? 'off';
    if (mode === 'off' || !info?.outputSchema) return undefined;
    const key = keyOf(serverId, tool);
    if (cfg?.tools?.length && !cfg.tools.some((g) => globMatch(g, key))) return undefined;
    const r = (result && typeof result === 'object' && !Array.isArray(result) ? result : {}) as { structuredContent?: unknown; isError?: unknown };
    if (r.isError === true) return undefined;
    const errors: SchemaError[] =
      r.structuredContent === undefined
        ? [{ path: '', message: 'the tool has an outputSchema but returned no structuredContent' }]
        : validateJsonSchema(info.outputSchema, r.structuredContent).errors;
    if (!errors.length) return undefined;
    this.bump(this.violations, key);
    return { key, errors, enforce: mode === 'enforce' };
  }

  /** `GET /api/v1/admin/ops/tool-schemas`: every listed tool with its digest, pin state and counters. */
  report(cfg: ToolSchemasConfig | undefined, tools: readonly ToolInfo[]): { validateOutput: string; onDrift: string; tools: ToolSchemaRow[]; missing: string[] } {
    const pins = cfg?.pins ?? {};
    const seen = new Set<string>();
    const rows = tools.map((t) => {
      const key = keyOf(t.serverId, t.name);
      seen.add(key);
      const sha256 = this.digest(t);
      return {
        server: t.serverId,
        tool: t.name,
        sha256,
        inputSchema: t.inputSchema !== undefined,
        outputSchema: t.outputSchema !== undefined,
        pinned: key in pins,
        drift: key in pins && pins[key] !== sha256,
        violations: this.violations.get(key) ?? 0,
        driftCalls: this.driftCalls.get(key) ?? 0,
        driftRefusals: this.driftRefusals.get(key) ?? 0,
      };
    });
    return { validateOutput: cfg?.validateOutput ?? 'off', onDrift: cfg?.onDrift ?? 'block', tools: rows, missing: Object.keys(pins).filter((k) => !seen.has(k)).sort() };
  }
}
