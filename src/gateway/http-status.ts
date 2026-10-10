/**
 * HTTP status of a tool-call result (13.1.2), shared by every REST surface that runs tool calls so the same refusal
 * answers the same way everywhere: `POST /api/v1/tools/call` (see gateway/api) and the agent API
 * (`POST /api/v1/features/agent-identity/call`). The MCP endpoint answers with the JSON-RPC error code itself.
 *
 *  - quota (-32007) and budget refusals (-32013 with `data.decision: budget`) → 429 (+ `Retry-After`)
 *  - gateway policy layer (authorizer, policy, approvals, plugins, residency, PII, failed security module, …) → 403;
 *    a blocked tool output → 502
 *  - server busy → 503, upstream timeout → 504, any other failure → 502
 *
 * @module gateway/http-status
 */

import type { ProxyResponse } from '../utils/types.js';
import { POLICY_ERROR_CODES, ERR_OUTPUT_BLOCKED } from './invoker.js';
import { ERR_QUOTA_EXCEEDED } from './usage.js';
import { ERR_SERVER_BUSY, ERR_TIMEOUT } from '../proxy/index.js';

const ERR_BUDGET_EXCEEDED = -32013;

export function toolCallHttpStatus(r: Pick<ProxyResponse, 'success' | 'error'>, now = Date.now()): { status: number; retryAfter?: number } {
  if (r.success) return { status: 200 };
  const code = r.error?.code;
  const data = (r.error?.data ?? {}) as { resetsAt?: string; retryAfterSeconds?: number; decision?: string };
  const wait = (): number | undefined => {
    const reset = data.resetsAt ? Date.parse(data.resetsAt) : NaN;
    const s = typeof data.retryAfterSeconds === 'number' ? data.retryAfterSeconds : Number.isFinite(reset) ? Math.ceil((reset - now) / 1000) : undefined;
    return s === undefined ? undefined : Math.max(1, s);
  };
  if (code === ERR_QUOTA_EXCEEDED) return { status: 429, retryAfter: wait() };
  if (code === ERR_BUDGET_EXCEEDED && data.decision === 'budget') return { status: 429, retryAfter: wait() };
  if (code !== undefined && POLICY_ERROR_CODES.has(code)) return { status: code === ERR_OUTPUT_BLOCKED ? 502 : 403 };
  if (code === ERR_SERVER_BUSY) return { status: 503, retryAfter: 1 };
  return { status: code === ERR_TIMEOUT ? 504 : 502 };
}
