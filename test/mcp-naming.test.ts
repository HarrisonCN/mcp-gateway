import { describe, it, expect } from 'vitest';
import { buildToolIndex, toMcpTool, prefixedName } from '../src/mcp/naming.js';
import type { ToolInfo } from '../src/utils/types.js';

const t = (serverId: string, name: string, extra: Partial<ToolInfo> = {}): ToolInfo => ({
  serverId,
  serverName: serverId,
  name,
  ...extra,
});

describe('buildToolIndex', () => {
  it('auto: keeps unique names, prefixes every copy of a colliding name', () => {
    const idx = buildToolIndex([t('b', 'echo'), t('a', 'echo'), t('a', 'read'), t('c', 'write')]);
    expect(idx.list.map((e) => e.name)).toEqual(['a__echo', 'read', 'b__echo', 'write']);
    expect(idx.byName.get('read')?.serverId).toBe('a');
    // prefixed alias for unique tools
    expect(idx.byName.get('c__write')?.name).toBe('write');
    expect(idx.byName.has('echo')).toBe(false);
  });

  it('is independent of input order', () => {
    const tools = [t('b', 'x'), t('a', 'x'), t('a', 'y')];
    const n1 = buildToolIndex(tools).list.map((e) => e.name);
    const n2 = buildToolIndex([...tools].reverse()).list.map((e) => e.name);
    expect(n1).toEqual(n2);
  });

  it('prefix: prefixes everything and has no bare aliases', () => {
    const idx = buildToolIndex([t('a', 'echo'), t('b', 'read')], 'prefix');
    expect(idx.list.map((e) => e.name)).toEqual(['a__echo', 'b__read']);
    expect(idx.byName.has('echo')).toBe(false);
  });

  it('skips a later tool whose exposed name is already taken', () => {
    const idx = buildToolIndex([t('a', 'b__c'), t('b', 'c'), t('x', 'c')]);
    // "c" collides → b__c and x__c; tool "b__c" on server a keeps its bare name and wins
    expect(idx.list.map((e) => `${e.tool.serverId}:${e.name}`)).toEqual(['a:b__c', 'x:x__c']);
  });

  it('toMcpTool passes through MCP fields and defaults inputSchema', () => {
    expect(toMcpTool({ name: 'n', tool: t('a', 'n') })).toEqual({ name: 'n', inputSchema: { type: 'object' } });
    const full = toMcpTool({
      name: 'a__n',
      tool: t('a', 'n', {
        title: 'N',
        description: 'd',
        inputSchema: { type: 'object', properties: {} },
        outputSchema: { type: 'object' },
        annotations: { readOnlyHint: true },
      }),
    });
    expect(full).toMatchObject({ name: 'a__n', title: 'N', description: 'd', annotations: { readOnlyHint: true } });
    expect(prefixedName('s', 't')).toBe('s__t');
  });
});
