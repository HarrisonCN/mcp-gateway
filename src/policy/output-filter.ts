/**
 * Output filtering for prompt-injection patterns (`policy.outputFilter`).
 *
 * Tool results are untrusted input for the model that reads them. The filter
 * scans the text of a result (`content[].text`, `structuredContent`) for
 * common injection phrasings and hidden-text tricks, then — per `action` —
 *  - `flag`:   passes the result through, annotated with
 *              `_meta["mcp-gateway/flags"]` (and logged / counted);
 *  - `redact`: replaces each match with `[filtered]` (default);
 *  - `block`:  replaces the whole result with an error.
 *
 * Patterns are heuristics; they reduce, not eliminate, injection risk.
 *
 * @module policy/output-filter
 */

import type { OutputFilterConfig } from '../utils/types.js';
import { globToRegExp } from '../utils/tool-filter.js';

/** Built-in detectors: id → pattern (global, case-insensitive). */
export const BUILTIN_INJECTION_PATTERNS: Record<string, string> = {
  'ignore-instructions':
    String.raw`\b(?:ignore|disregard|forget|override)\s+(?:all\s+|any\s+|the\s+)?(?:previous|prior|above|earlier|preceding|system)\s+(?:instructions?|prompts?|rules|messages?|directions?)`,
  'new-instructions': String.raw`\b(?:new|updated|real|actual)\s+(?:system\s+)?instructions?\s*:`,
  'role-override': String.raw`\byou\s+are\s+now\s+(?:in\s+)?(?:DAN|developer\s+mode|jailbroken|unrestricted|an?\s+(?:unfiltered|uncensored))`,
  'fake-role-tags': String.raw`<\s*/?\s*(?:system|assistant|im_start|im_end|\|im_start\||\|im_end\|)\s*>|\[/?(?:INST|SYS)\]`,
  'prompt-exfiltration': String.raw`\b(?:reveal|print|repeat|output|show)\s+(?:your|the)\s+(?:system\s+prompt|hidden\s+instructions|initial\s+instructions)`,
  'tool-hijack': String.raw`\b(?:call|invoke|run|execute)\s+the\s+[\w.-]+\s+tool\s+(?:with|to)\b[^.\n]{0,80}\b(?:secret|token|password|credential|api[_ ]?key)`,
  'exfil-url': String.raw`!\[[^\]]*\]\(https?://[^)\s]+[?&][^)\s]*=(?:\{|%7B|\$)`,
  'hidden-unicode': String.raw`[\u200B-\u200F\u202A-\u202E\u2060-\u2064\uFEFF]{3,}|[\u{E0000}-\u{E007F}]+`,
};

export interface FilterFinding {
  pattern: string;
  /** Matched text (truncated to 80 characters). */
  match: string;
}

export interface FilterOutcome {
  /** The (possibly modified) result. */
  result: unknown;
  findings: FilterFinding[];
  blocked: boolean;
}

interface Compiled {
  id: string;
  re: RegExp;
}

export class OutputFilter {
  private readonly patterns: Compiled[];

  constructor(readonly config: OutputFilterConfig) {
    const entries: Array<[string, string]> = [];
    if (config.builtins !== false) entries.push(...Object.entries(BUILTIN_INJECTION_PATTERNS));
    (config.patterns ?? []).forEach((p, i) => entries.push([`custom-${i + 1}`, p]));
    this.patterns = entries.map(([id, p]) => ({ id, re: new RegExp(p, 'giu') }));
  }

  get action(): 'flag' | 'redact' | 'block' {
    return this.config.action ?? 'redact';
  }

  /** Whether the filter applies to `serverId/tool`. */
  appliesTo(serverId: string, tool: string): boolean {
    if (this.config.enabled === false) return false;
    const list = this.config.tools;
    if (!list || list.length === 0) return true;
    return list.some((p) => globToRegExp(p).test(p.includes('/') ? `${serverId}/${tool}` : tool));
  }

  /** Scan (and per `action`, rewrite) one string. */
  scanText(text: string, findings: FilterFinding[]): string {
    let out = text;
    for (const { id, re } of this.patterns) {
      re.lastIndex = 0;
      if (!re.test(out)) continue;
      re.lastIndex = 0;
      out = out.replace(re, (m) => {
        findings.push({ pattern: id, match: m.length > 80 ? `${m.slice(0, 77)}...` : m });
        return this.action === 'redact' ? '[filtered]' : m;
      });
    }
    return out;
  }

  /** Apply to an MCP `CallToolResult`. */
  apply(result: unknown): FilterOutcome {
    const findings: FilterFinding[] = [];
    if (!result || typeof result !== 'object') return { result, findings, blocked: false };
    const r = { ...(result as Record<string, unknown>) };
    if (Array.isArray(r.content)) {
      r.content = r.content.map((item: unknown) => {
        if (!item || typeof item !== 'object') return item;
        const it = item as Record<string, unknown>;
        if (typeof it.text === 'string') return { ...it, text: this.scanText(it.text, findings) };
        const res = it.resource as Record<string, unknown> | undefined;
        if (it.type === 'resource' && res && typeof res.text === 'string') {
          return { ...it, resource: { ...res, text: this.scanText(res.text, findings) } };
        }
        return item;
      });
    }
    if (r.structuredContent !== undefined) {
      const json = JSON.stringify(r.structuredContent);
      const scanned = this.scanText(json, findings);
      if (scanned !== json) {
        try {
          r.structuredContent = JSON.parse(scanned);
        } catch {
          r.structuredContent = { filtered: true };
        }
      }
    }
    if (findings.length === 0) return { result, findings, blocked: false };
    if (this.action === 'block') {
      return {
        result: {
          content: [{ type: 'text', text: `[mcp-gateway] Tool output blocked: possible prompt injection (${[...new Set(findings.map((f) => f.pattern))].join(', ')})` }],
          isError: true,
        },
        findings,
        blocked: true,
      };
    }
    const meta = { ...((r._meta as Record<string, unknown>) ?? {}) };
    meta['mcp-gateway/flags'] = { promptInjection: [...new Set(findings.map((f) => f.pattern))], action: this.action };
    r._meta = meta;
    return { result: r, findings, blocked: false };
  }
}

/** Compile check for `policy.outputFilter.patterns` (error message or undefined). */
export function invalidFilterPattern(patterns: readonly string[] | undefined): string | undefined {
  for (const p of patterns ?? []) {
    try {
      new RegExp(p, 'giu');
    } catch (err) {
      return `"${p}": ${err instanceof Error ? err.message : String(err)}`;
    }
  }
  return undefined;
}
