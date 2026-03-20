/**
 * Unit tests for memory-recall wrapper.
 *
 * Verifies:
 *   - vertexType is always 'Memory'
 *   - agent filter is enforced
 *   - 3-signal default (semantic, keyword, graph — no structural)
 *   - conversationId filter is passed
 *   - embedding config comes from MemoryConfig
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { KadiClient } from '@kadi.build/core';

import type { MemoryConfig } from '../../src/lib/config.js';
import type { SignalAbilities } from '../../src/lib/graph-types.js';
import { registerRecallTool } from '../../src/tools/recall.js';

// ── Helpers ───────────────────────────────────────────────────────────

function createMockConfig(overrides: Partial<MemoryConfig> = {}): MemoryConfig {
  return {
    database: 'test_memory',
    embeddingModel: 'text-embedding-3-small',
    extractionModel: 'gpt-5-nano',
    summarizationModel: 'gpt-5-mini',
    chatModel: 'gpt-5-mini',
    defaultAgent: 'test-agent',
    apiKey: 'test-key',
    apiUrl: 'https://test.api',
    embeddingTransport: 'api',
    chatTransport: 'api',
    ...overrides,
  };
}

interface ToolRegistration {
  schema: { name: string; description: string; input: any };
  handler: (input: any) => Promise<any>;
}

function createMockClient(): { client: KadiClient; registeredTools: Map<string, ToolRegistration> } {
  const registeredTools = new Map<string, ToolRegistration>();

  const client = {
    registerTool: vi.fn((schema: any, handler: any) => {
      registeredTools.set(schema.name, { schema, handler });
    }),
  } as unknown as KadiClient;

  return { client, registeredTools };
}

function createMockAbilities(): { abilities: SignalAbilities; invokeCalls: Array<{ tool: string; params: Record<string, unknown> }> } {
  const invokeCalls: Array<{ tool: string; params: Record<string, unknown> }> = [];

  const abilities: SignalAbilities = {
    invoke: vi.fn(async <T>(tool: string, params: Record<string, unknown>): Promise<T> => {
      invokeCalls.push({ tool, params });

      if (tool === 'graph-recall') {
        return {
          results: [
            {
              rid: '#20:0',
              id: '#20:0',
              content: 'Test memory content',
              score: 0.95,
              importance: 0.8,
              matchedVia: ['semantic'],
              properties: { agent: 'test-agent' },
            },
          ],
          count: 1,
          mode: params.mode ?? 'hybrid',
          signals: params.signals ?? ['semantic', 'keyword', 'graph'],
        } as T;
      }

      return { success: true } as T;
    }),
  };

  return { abilities, invokeCalls };
}

// ── Tests ─────────────────────────────────────────────────────────────

describe('memory-recall wrapper', () => {
  let config: MemoryConfig;
  let mockAbilities: ReturnType<typeof createMockAbilities>;
  let tools: Map<string, ToolRegistration>;
  let invocations: Array<{ tool: string; params: Record<string, unknown> }>;

  beforeEach(() => {
    config = createMockConfig();
    const mock = createMockClient();
    mockAbilities = createMockAbilities();
    tools = mock.registeredTools;
    invocations = mockAbilities.invokeCalls;
    registerRecallTool(mock.client, config, mockAbilities.abilities);
  });

  it('registers a tool named memory-recall', () => {
    expect(tools.has('memory-recall')).toBe(true);
  });

  it('enforces vertexType=Memory on graph-recall call', async () => {
    const handler = tools.get('memory-recall')!.handler;
    await handler({ query: 'test query' });

    const recallCall = invocations.find((i) => i.tool === 'graph-recall');
    expect(recallCall).toBeDefined();
    expect(recallCall!.params.vertexType).toBe('Memory');
  });

  it('adds agent filter from config when not provided', async () => {
    const handler = tools.get('memory-recall')!.handler;
    await handler({ query: 'test query' });

    const recallCall = invocations.find((i) => i.tool === 'graph-recall');
    const filters = recallCall!.params.filters as Record<string, unknown>;
    expect(filters.agent).toBe('test-agent');
  });

  it('uses provided agent over config default', async () => {
    const handler = tools.get('memory-recall')!.handler;
    await handler({ query: 'test query', agent: 'custom-agent' });

    const recallCall = invocations.find((i) => i.tool === 'graph-recall');
    const filters = recallCall!.params.filters as Record<string, unknown>;
    expect(filters.agent).toBe('custom-agent');
  });

  it('defaults to 3-signal set (semantic, keyword, graph)', async () => {
    const handler = tools.get('memory-recall')!.handler;
    await handler({ query: 'test query' });

    const recallCall = invocations.find((i) => i.tool === 'graph-recall');
    expect(recallCall!.params.signals).toEqual(['semantic', 'keyword', 'graph']);
  });

  it('does NOT include structural signal by default', async () => {
    const handler = tools.get('memory-recall')!.handler;
    await handler({ query: 'test query' });

    const recallCall = invocations.find((i) => i.tool === 'graph-recall');
    const signals = recallCall!.params.signals as string[];
    expect(signals).not.toContain('structural');
  });

  it('allows custom signal set override', async () => {
    const handler = tools.get('memory-recall')!.handler;
    await handler({ query: 'test query', signals: ['semantic'] });

    const recallCall = invocations.find((i) => i.tool === 'graph-recall');
    expect(recallCall!.params.signals).toEqual(['semantic']);
  });

  it('defaults to hybrid mode', async () => {
    const handler = tools.get('memory-recall')!.handler;
    await handler({ query: 'test query' });

    const recallCall = invocations.find((i) => i.tool === 'graph-recall');
    expect(recallCall!.params.mode).toBe('hybrid');
  });

  it('respects explicit mode', async () => {
    const handler = tools.get('memory-recall')!.handler;
    await handler({ query: 'test query', mode: 'semantic' });

    const recallCall = invocations.find((i) => i.tool === 'graph-recall');
    expect(recallCall!.params.mode).toBe('semantic');
  });

  it('defaults limit to 10', async () => {
    const handler = tools.get('memory-recall')!.handler;
    await handler({ query: 'test query' });

    const recallCall = invocations.find((i) => i.tool === 'graph-recall');
    expect(recallCall!.params.limit).toBe(10);
  });

  it('passes explicit limit', async () => {
    const handler = tools.get('memory-recall')!.handler;
    await handler({ query: 'test query', limit: 5 });

    const recallCall = invocations.find((i) => i.tool === 'graph-recall');
    expect(recallCall!.params.limit).toBe(5);
  });

  it('adds conversationId to filters when provided', async () => {
    const handler = tools.get('memory-recall')!.handler;
    await handler({ query: 'test query', conversationId: 'conv-123' });

    const recallCall = invocations.find((i) => i.tool === 'graph-recall');
    const filters = recallCall!.params.filters as Record<string, unknown>;
    expect(filters.conversationId).toBe('conv-123');
  });

  it('passes embedding config from MemoryConfig', async () => {
    const handler = tools.get('memory-recall')!.handler;
    await handler({ query: 'test query' });

    const recallCall = invocations.find((i) => i.tool === 'graph-recall');
    expect(recallCall!.params.embedding).toEqual({
      model: 'text-embedding-3-small',
      transport: 'api',
      apiUrl: 'https://test.api',
      apiKey: 'test-key',
    });
  });

  it('passes database from config', async () => {
    const handler = tools.get('memory-recall')!.handler;
    await handler({ query: 'test query' });

    const recallCall = invocations.find((i) => i.tool === 'graph-recall');
    expect(recallCall!.params.database).toBe('test_memory');
  });

  it('returns results from graph-recall', async () => {
    const handler = tools.get('memory-recall')!.handler;
    const result = await handler({ query: 'test query' });

    expect(result.results).toBeDefined();
    expect(result.count).toBe(1);
    expect(result.agent).toBe('test-agent');
  });

  it('returns error on failure', async () => {
    (mockAbilities.abilities.invoke as any).mockRejectedValueOnce(new Error('Broker unavailable'));

    const handler = tools.get('memory-recall')!.handler;
    const result = await handler({ query: 'test query' });

    expect(result.success).toBe(false);
    expect(result.error).toContain('Broker unavailable');
  });
});
