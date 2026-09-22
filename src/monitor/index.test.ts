import { describe, expect, it } from 'vitest';
import { MetricsCollector } from './index.js';

describe('MetricsCollector', () => {
  it('caches aggregate results until new metrics arrive', () => {
    const collector = new MetricsCollector({ retentionHours: 1 });
    collector.record({
      serverId: 's1',
      toolName: 'tool-a',
      durationMs: 10,
      success: true,
    });

    const first = collector.aggregate(60_000);
    const second = collector.aggregate(60_000);

    expect(second).toBe(first);

    collector.record({
      serverId: 's1',
      toolName: 'tool-a',
      durationMs: 20,
      success: true,
    });

    const third = collector.aggregate(60_000);
    expect(third).not.toBe(first);
    expect(third.totalRequests).toBe(2);
  });
});
