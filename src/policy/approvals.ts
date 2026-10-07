/**
 * Human-in-the-loop approvals for tool calls flagged by a policy rule with
 * `effect: approve`. The call is held until an operator approves or denies
 * it (dashboard *Approvals* page, `POST /api/v1/approvals/:id/approve|deny`)
 * or `policy.approval.timeoutSeconds` passes (→ denied).
 *
 * @module policy/approvals
 */

import { EventEmitter } from 'events';
import { randomUUID } from 'crypto';
import { redactValue } from '../security/redact.js';

export type ApprovalStatus = 'pending' | 'approved' | 'denied' | 'expired' | 'cancelled';

export interface ApprovalRequest {
  id: string;
  status: ApprovalStatus;
  clientId?: string;
  serverId: string;
  tool: string;
  /** Arguments with secret-looking values masked. */
  arguments: unknown;
  rule?: string;
  message?: string;
  via: 'rest' | 'mcp';
  createdAt: string;
  expiresAt: string;
  decidedAt?: string;
  decidedBy?: string;
  reason?: string;
}

export interface ApprovalOptions {
  timeoutSeconds?: number;
  /** Let the client that made the call approve it itself (default false). */
  allowSelfApproval?: boolean;
  /** Decided requests kept for the history view (default 100). */
  historySize?: number;
}

interface Pending {
  req: ApprovalRequest;
  resolve: (status: ApprovalStatus) => void;
  timer: NodeJS.Timeout;
}

export class ApprovalError extends Error {
  constructor(
    message: string,
    readonly status: 404 | 403 | 409,
  ) {
    super(message);
  }
}

export class ApprovalQueue extends EventEmitter {
  private readonly pending = new Map<string, Pending>();
  private history: ApprovalRequest[] = [];
  private options: Required<ApprovalOptions>;

  constructor(options: ApprovalOptions = {}) {
    super();
    this.options = { timeoutSeconds: 300, allowSelfApproval: false, historySize: 100, ...stripUndefined(options) };
  }

  configure(options: ApprovalOptions = {}): void {
    this.options = { timeoutSeconds: 300, allowSelfApproval: false, historySize: 100, ...stripUndefined(options) };
  }

  /** Hold a call until it is decided. Resolves with the final status. */
  request(
    input: { clientId?: string; serverId: string; tool: string; args: unknown; rule?: string; message?: string; via: 'rest' | 'mcp' },
    signal?: AbortSignal,
  ): Promise<ApprovalStatus> {
    const now = Date.now();
    const req: ApprovalRequest = {
      id: randomUUID(),
      status: 'pending',
      clientId: input.clientId,
      serverId: input.serverId,
      tool: input.tool,
      arguments: redactValue(input.args),
      rule: input.rule,
      message: input.message,
      via: input.via,
      createdAt: new Date(now).toISOString(),
      expiresAt: new Date(now + this.options.timeoutSeconds * 1000).toISOString(),
    };
    return new Promise<ApprovalStatus>((resolve) => {
      const timer = setTimeout(() => this.finish(req.id, 'expired'), this.options.timeoutSeconds * 1000);
      timer.unref();
      this.pending.set(req.id, { req, resolve, timer });
      if (signal) {
        if (signal.aborted) return this.finish(req.id, 'cancelled');
        signal.addEventListener('abort', () => this.finish(req.id, 'cancelled'), { once: true });
      }
      this.emit('requested', req);
    });
  }

  private finish(id: string, status: ApprovalStatus, by?: string, reason?: string): ApprovalRequest | undefined {
    const p = this.pending.get(id);
    if (!p) return undefined;
    this.pending.delete(id);
    clearTimeout(p.timer);
    p.req.status = status;
    p.req.decidedAt = new Date().toISOString();
    if (by) p.req.decidedBy = by;
    if (reason) p.req.reason = reason;
    this.history.unshift(p.req);
    if (this.history.length > this.options.historySize) this.history.length = this.options.historySize;
    this.emit('decided', p.req);
    p.resolve(status);
    return p.req;
  }

  /** Approve or deny a pending request. Throws `ApprovalError`. */
  decide(id: string, approve: boolean, by?: string, reason?: string): ApprovalRequest {
    const p = this.pending.get(id);
    if (!p) {
      if (this.history.some((h) => h.id === id)) throw new ApprovalError('Approval request was already decided', 409);
      throw new ApprovalError('Approval request not found', 404);
    }
    if (!this.options.allowSelfApproval && by !== undefined && p.req.clientId !== undefined && by === p.req.clientId) {
      throw new ApprovalError('A client cannot approve its own tool call (policy.approval.allowSelfApproval)', 403);
    }
    return this.finish(id, approve ? 'approved' : 'denied', by, reason)!;
  }

  list(): { pending: ApprovalRequest[]; recent: ApprovalRequest[] } {
    return { pending: [...this.pending.values()].map((p) => p.req), recent: [...this.history] };
  }

  get(id: string): ApprovalRequest | undefined {
    return this.pending.get(id)?.req ?? this.history.find((h) => h.id === id);
  }

  pendingCount(): number {
    return this.pending.size;
  }

  /** Deny everything pending (shutdown). */
  close(): void {
    for (const id of [...this.pending.keys()]) this.finish(id, 'cancelled');
  }
}

function stripUndefined<T extends object>(o: T): Partial<T> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Partial<T>;
}
