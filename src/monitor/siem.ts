/**
 * Audit export to a SIEM: every request record is forwarded to syslog (RFC 5424, UDP / TCP / TLS) and / or HTTP
 * webhooks (batched JSON or NDJSON, e.g. Splunk HEC, Elastic, Datadog, Loki via a collector).
 *
 * Only the same metadata as the audit log is exported (never arguments or results). Export never blocks or fails a
 * request: records are queued (bounded, oldest dropped) and sent in the background with retries.
 *
 * @module monitor/siem
 */

import { createSocket, type Socket as UdpSocket } from 'dgram';
import { connect as tcpConnect, type Socket } from 'net';
import { connect as tlsConnect } from 'tls';
import { hostname } from 'os';
import type { AuditExportTarget, RequestMetric } from '../utils/types.js';
import { logger } from '../utils/logger.js';

/** The exported shape of one record (stable field names for SIEM parsers). */
export interface AuditEvent {
  '@timestamp': string;
  event: 'mcp_gateway.request';
  id: string;
  server: string;
  name: string;
  kind: 'tool' | 'resource' | 'prompt';
  via?: 'rest' | 'mcp';
  client: string;
  success: boolean;
  durationMs: number;
  error?: string;
  host: string;
}

const HOST = hostname();

export function toAuditEvent(m: RequestMetric): AuditEvent {
  return {
    '@timestamp': m.timestamp.toISOString(),
    event: 'mcp_gateway.request',
    id: m.id,
    server: m.serverId,
    name: m.toolName,
    kind: m.kind ?? 'tool',
    ...(m.via ? { via: m.via } : {}),
    client: m.clientId ?? 'anonymous',
    success: m.success,
    durationMs: m.durationMs,
    ...(m.errorMessage ? { error: m.errorMessage } : {}),
    host: HOST,
  };
}

const FACILITIES: Record<string, number> = { kern: 0, user: 1, daemon: 3, auth: 4, syslog: 5, authpriv: 10, local0: 16, local1: 17, local2: 18, local3: 19, local4: 20, local5: 21, local6: 22, local7: 23 };

/** RFC 5424 line: `<PRI>1 TIMESTAMP HOST APP - MSGID [sd] JSON`. Failures are `warning` (4), successes `info` (6). */
export function formatSyslog(e: AuditEvent, opts: { facility?: string; appName?: string } = {}): string {
  const fac = FACILITIES[opts.facility ?? 'local0'] ?? 16;
  const pri = fac * 8 + (e.success ? 6 : 4);
  const esc = (v: string) => v.replace(/["\\\]]/g, (c) => `\\${c}`);
  const sd = `[mcpgw@32473 server="${esc(e.server)}" name="${esc(e.name)}" client="${esc(e.client)}" success="${e.success}" durationMs="${e.durationMs}"]`;
  const app = (opts.appName ?? 'mcp-gateway').replace(/\s/g, '_').slice(0, 48);
  return `<${pri}>1 ${e['@timestamp']} ${e.host || '-'} ${app} - request ${sd} ${JSON.stringify(e)}`;
}

interface Sink {
  send(events: AuditEvent[]): Promise<void>;
  close(): void;
}

class SyslogSink implements Sink {
  private udp?: UdpSocket;
  private tcp?: Socket;
  constructor(private readonly t: Extract<AuditExportTarget, { type: 'syslog' }>) {}

  private stream(): Promise<Socket> {
    if (this.tcp && !this.tcp.destroyed) return Promise.resolve(this.tcp);
    return new Promise((resolve, reject) => {
      const port = this.t.port ?? (this.t.protocol === 'tls' ? 6514 : 514);
      const s = this.t.protocol === 'tls' ? tlsConnect({ host: this.t.host, port, servername: this.t.host }) : tcpConnect({ host: this.t.host, port });
      s.once(this.t.protocol === 'tls' ? 'secureConnect' : 'connect', () => resolve(s));
      s.once('error', (err) => {
        s.destroy();
        reject(err);
      });
      s.on('close', () => {
        if (this.tcp === s) this.tcp = undefined;
      });
      s.unref();
      this.tcp = s;
    });
  }

  async send(events: AuditEvent[]): Promise<void> {
    const lines = events.map((e) => formatSyslog(e, this.t));
    if ((this.t.protocol ?? 'udp') === 'udp') {
      this.udp ??= createSocket(this.t.host.includes(':') ? 'udp6' : 'udp4');
      this.udp.unref();
      const port = this.t.port ?? 514;
      await Promise.all(lines.map((l) => new Promise<void>((res, rej) => this.udp!.send(l, port, this.t.host, (err) => (err ? rej(err) : res())))));
      return;
    }
    const s = await this.stream();
    // RFC 6587 octet counting framing
    const payload = lines.map((l) => `${Buffer.byteLength(l)} ${l}`).join('');
    await new Promise<void>((res, rej) => s.write(payload, (err) => (err ? rej(err) : res())));
  }

  close(): void {
    this.udp?.close();
    this.tcp?.end();
  }
}

class WebhookSink implements Sink {
  constructor(
    private readonly t: Extract<AuditExportTarget, { type: 'webhook' }>,
    private readonly fetchImpl: typeof fetch,
  ) {}

  async send(events: AuditEvent[]): Promise<void> {
    const ndjson = this.t.format === 'ndjson';
    const body = ndjson ? events.map((e) => JSON.stringify(e)).join('\n') + '\n' : JSON.stringify({ events });
    const res = await this.fetchImpl(this.t.url, {
      method: 'POST',
      headers: { 'content-type': ndjson ? 'application/x-ndjson' : 'application/json', ...(this.t.headers ?? {}) },
      body,
      signal: AbortSignal.timeout(this.t.timeoutMs ?? 10_000),
    });
    if (!res.ok) throw new Error(`webhook ${this.t.url} answered ${res.status}`);
  }

  close(): void {}
}

export interface ExporterStats {
  target: string;
  type: AuditExportTarget['type'];
  sent: number;
  failed: number;
  dropped: number;
  queued: number;
  lastError?: string;
}

class Lane {
  readonly queue: AuditEvent[] = [];
  stats: ExporterStats;
  private timer?: NodeJS.Timeout;
  private sending?: Promise<void>;
  constructor(
    readonly target: AuditExportTarget,
    private readonly sink: Sink,
  ) {
    this.stats = { target: target.type === 'syslog' ? `${target.host}:${target.port ?? ''}` : target.url, type: target.type, sent: 0, failed: 0, dropped: 0, queued: 0 };
  }

  private get batchSize() {
    return this.target.batchSize ?? (this.target.type === 'syslog' ? 1 : 100);
  }

  push(e: AuditEvent): void {
    const max = this.target.maxQueue ?? 10_000;
    this.queue.push(e);
    if (this.queue.length > max) this.stats.dropped += this.queue.splice(0, this.queue.length - max).length;
    this.stats.queued = this.queue.length;
    if (this.queue.length >= this.batchSize) void this.flush();
    else if (!this.timer) {
      this.timer = setTimeout(() => void this.flush(), this.target.flushIntervalMs ?? 1000);
      this.timer.unref();
    }
  }

  async flush(): Promise<void> {
    clearTimeout(this.timer);
    this.timer = undefined;
    if (this.sending) return this.sending.then(() => (this.queue.length ? this.flush() : undefined));
    if (this.queue.length === 0) return;
    this.sending = (async () => {
      while (this.queue.length > 0) {
        const batch = this.queue.splice(0, Math.max(this.batchSize, 1));
        let attempt = 0;
        for (;;) {
          try {
            await this.sink.send(batch);
            this.stats.sent += batch.length;
            break;
          } catch (err) {
            this.stats.lastError = err instanceof Error ? err.message : String(err);
            if (++attempt > (this.target.retries ?? 2)) {
              this.stats.failed += batch.length;
              if (this.stats.failed === batch.length || this.stats.failed % 1000 < batch.length) logger.warn(`Audit export to ${this.stats.target} failed: ${this.stats.lastError}`);
              break;
            }
            await new Promise((r) => setTimeout(r, 100 * 2 ** attempt));
          }
        }
      }
    })().finally(() => {
      this.sending = undefined;
      this.stats.queued = this.queue.length;
    });
    return this.sending;
  }

  close(): void {
    clearTimeout(this.timer);
    this.sink.close();
  }
}

/** Fans request records out to every configured SIEM target. */
export class AuditExporter {
  private readonly lanes: Lane[];
  constructor(targets: AuditExportTarget[], opts: { fetch?: typeof fetch } = {}) {
    const f = opts.fetch ?? ((...a: Parameters<typeof fetch>) => fetch(...a));
    this.lanes = targets.filter((t) => t.enabled !== false).map((t) => new Lane(t, t.type === 'syslog' ? new SyslogSink(t) : new WebhookSink(t, f)));
  }

  get size(): number {
    return this.lanes.length;
  }

  push(m: RequestMetric): void {
    if (this.lanes.length === 0) return;
    const e = toAuditEvent(m);
    for (const l of this.lanes) {
      const kinds = l.target.kinds;
      if (kinds && !kinds.includes(e.kind)) continue;
      if (l.target.failuresOnly && e.success) continue;
      l.push(e);
    }
  }

  async flush(): Promise<void> {
    await Promise.all(this.lanes.map((l) => l.flush()));
  }

  stats(): ExporterStats[] {
    return this.lanes.map((l) => ({ ...l.stats, queued: l.queue.length }));
  }

  async close(): Promise<void> {
    await Promise.race([this.flush(), new Promise((r) => setTimeout(r, 2000).unref())]);
    for (const l of this.lanes) l.close();
  }
}
