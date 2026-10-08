/** 4.1: MCP revision negotiation and per-version shaping. */
import { describe, it, expect } from 'vitest';
import { PROTOCOL_VERSIONS, adaptTool, adaptToolResult, featuresOf, negotiateVersion, supports, unknownVersions } from '../src/mcp/compat.js';
import { validateConfig } from '../src/config/loader.js';

const tool = { name: 'search', title: 'Search', inputSchema: { type: 'object' }, outputSchema: { type: 'object' }, annotations: { readOnlyHint: true } };
const result = {
  content: [
    { type: 'resource_link', uri: 'file:///r/a.md', name: 'a.md', annotations: { audience: ['user'] } },
  ],
  structuredContent: { hits: 2 },
};

describe('protocol negotiation', () => {
  it('knows the revisions and features', () => {
    expect(PROTOCOL_VERSIONS[0]).toBe('2025-11-25');
    expect(negotiateVersion('2025-03-26')).toBe('2025-03-26');
    expect(negotiateVersion('2030-01-01')).toBe('2025-11-25');
    expect(negotiateVersion(undefined, ['2025-03-26', '2025-06-18'])).toBe('2025-06-18');
    expect(supports('2025-03-26', 'annotations')).toBe(true);
    expect(supports('2025-03-26', 'structuredContent')).toBe(false);
    expect(featuresOf('2024-11-05').annotations).toBe(false);
    expect(unknownVersions(['2025-06-18', '1999-01-01'])).toEqual(['1999-01-01']);
  });

  it('validates mcp.protocolVersions', () => {
    expect(validateConfig({ mcp: { protocolVersions: ['2025-06-18'] } }).mcp?.protocolVersions).toEqual(['2025-06-18']);
    expect(() => validateConfig({ mcp: { protocolVersions: ['2020-01-01'] } })).toThrow(/unknown MCP revision/);
  });
});

describe('shaping', () => {
  it('passes everything through to current clients (adds the text block for structured output)', () => {
    expect(adaptTool(tool, '2025-11-25')).toEqual(tool);
    const r = adaptToolResult(result, '2025-06-18') as { content: Array<Record<string, unknown>>; structuredContent: unknown };
    expect(r.structuredContent).toEqual({ hits: 2 });
    expect(r.content[0]).toMatchObject({ type: 'resource_link', annotations: { audience: ['user'] } });
    expect(r.content[1]).toEqual({ type: 'text', text: '{"hits":2}' });
  });

  it('downgrades for older clients', () => {
    expect(adaptTool(tool, '2025-03-26')).toEqual({ name: 'search', inputSchema: { type: 'object' }, annotations: { readOnlyHint: true } });
    expect(adaptTool(tool, '2024-11-05')).toEqual({ name: 'search', inputSchema: { type: 'object' } });
    const r = adaptToolResult(result, '2024-11-05') as Record<string, unknown>;
    expect(r.structuredContent).toBeUndefined();
    expect(r.content).toEqual([{ type: 'text', text: 'a.md: file:///r/a.md' }, { type: 'text', text: '{"hits":2}' }]);
    expect(adaptToolResult('x', '2024-11-05')).toBe('x');
  });
});
