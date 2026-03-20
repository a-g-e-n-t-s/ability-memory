/**
 * Unit tests for memory-store wrapper.
 *
 * Verifies enforced defaults:
 *   - vertexType is always 'Memory'
 *   - agent is auto-added from config or input
 *   - timestamp is auto-added
 *   - conversationId creates InConversation edge + Conversation upsert
 *   - metadata is JSON-stringified
 *   - embedding config comes from MemoryConfig
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { KadiClient, z } from '@kadi.build/core';

import type { MemoryConfig } from '../../src/lib/config.js';
import type { SignalAbilities } from '../../src/lib/graph-types.js';
import { registerStoreTool } from '../../src/tools/store.js';

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

      // Mock responses
      if (tool === 'graph-store') {
        return {
          stored: true,
          rid: '#20:0',
          vertexType: params.vertexType,
          topics: params.topics ?? [],
          entities: params.entities ?? [],
          importance: 0.5,
          embeddingDimensions: 1536,
          durationMs: 100,
        } as T;
      }

      if (tool === 'graph-query') {
        return { success: true, result: [] } as T;
      }

      if (tool === 'graph-command') {
        return { success: true, result: [{ '@rid': '#30:0' }] } as T;
      }

      return { success: true } as T;
    }),
  };

  return { abilities, invokeCalls };
}

// ── Tests ─────────────────────────────────────────────────────────────

describe('memory-store wrapper', () => {
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
    registerStoreTool(mock.client, config, mockAbilities.abilities);
  });

  it('registers a tool named memory-store', () => {
    expect(tools.has('memory-store')).toBe(true);
  });

  it('enforces vertexType=Memory on the graph-store call', async () => {
    const handler = tools.get('memory-store')!.handler;
    await handler({ content: 'Test memory content' });

    const graphStoreCall = invocations.find((i) => i.tool === 'graph-store');
    expect(graphStoreCall).toBeDefined();
    expect(graphStoreCall!.params.vertexType).toBe('Memory');
  });

  it('adds agent from config when not provided', async () => {
    const handler = tools.get('memory-store')!.handler;
    const result = await handler({ content: 'Test memory' });

    const graphStoreCall = invocations.find((i) => i.tool === 'graph-store');
    expect(graphStoreCall!.params.properties).toMatchObject({ agent: 'test-agent' });
    expect(result.agent).toBe('test-agent');
  });

  it('uses provided agent over config default', async () => {
    const handler = tools.get('memory-store')!.handler;
    const result = await handler({ content: 'Test memory', agent: 'custom-agent' });

    const graphStoreCall = invocations.find((i) => i.tool === 'graph-store');
    expect(graphStoreCall!.params.properties).toMatchObject({ agent: 'custom-agent' });
    expect(result.agent).toBe('custom-agent');
  });

  it('auto-adds timestamp to properties', async () => {
    const handler = tools.get('memory-store')!.handler;
    const beforeTime = new Date().toISOString();
    await handler({ content: 'Test memory' });
    const afterTime = new Date().toISOString();

    const graphStoreCall = invocations.find((i) => i.tool === 'graph-store');
    const props = graphStoreCall!.params.properties as Record<string, unknown>;
    expect(props.timestamp).toBeDefined();
    expect(typeof props.timestamp).toBe('string');
    // Timestamp should be between before and after
    expect(props.timestamp as string >= beforeTime).toBe(true);
    expect(props.timestamp as string <= afterTime).toBe(true);
  });

  it('passes embedding config from MemoryConfig', async () => {
    const handler = tools.get('memory-store')!.handler;
    await handler({ content: 'Test memory' });

    const graphStoreCall = invocations.find((i) => i.tool === 'graph-store');
    expect(graphStoreCall!.params.embedding).toEqual({
      model: 'text-embedding-3-small',
      transport: 'api',
      apiUrl: 'https://test.api',
      apiKey: 'test-key',
    });
  });

  it('passes database from config', async () => {
    const handler = tools.get('memory-store')!.handler;
    await handler({ content: 'Test memory' });

    const graphStoreCall = invocations.find((i) => i.tool === 'graph-store');
    expect(graphStoreCall!.params.database).toBe('test_memory');
  });

  it('adds conversationId to properties when provided', async () => {
    const handler = tools.get('memory-store')!.handler;
    await handler({ content: 'Test memory', conversationId: 'conv-123' });

    const graphStoreCall = invocations.find((i) => i.tool === 'graph-store');
    const props = graphStoreCall!.params.properties as Record<string, unknown>;
    expect(props.conversationId).toBe('conv-123');
  });

  it('creates InConversation edge when conversationId provided', async () => {
    const handler = tools.get('memory-store')!.handler;
    await handler({ content: 'Test memory', conversationId: 'conv-123' });

    const graphStoreCall = invocations.find((i) => i.tool === 'graph-store');
    const edges = graphStoreCall!.params.edges as Array<any>;
    expect(edges).toBeDefined();
    expect(edges.length).toBeGreaterThanOrEqual(1);

    const convEdge = edges.find((e: any) => e.type === 'InConversation');
    expect(convEdge).toBeDefined();
    expect(convEdge.direction).toBe('out');
    expect(convEdge.targetQuery).toEqual({
      vertexType: 'Conversation',
      where: { conversationId: 'conv-123' },
    });
  });

  it('upserts Conversation vertex when conversationId provided', async () => {
    const handler = tools.get('memory-store')!.handler;
    await handler({ content: 'Test memory', conversationId: 'conv-123' });

    // Should query for existing conversation, then create since result was empty
    const queryCall = invocations.find(
      (i) => i.tool === 'graph-query' && (i.params.query as string).includes('Conversation'),
    );
    expect(queryCall).toBeDefined();

    // Should create new conversation since none existed
    const createCall = invocations.find(
      (i) => i.tool === 'graph-command' && (i.params.command as string).includes('CREATE VERTEX Conversation'),
    );
    expect(createCall).toBeDefined();
  });

  it('stringifies metadata as JSON', async () => {
    const handler = tools.get('memory-store')!.handler;
    await handler({ content: 'Test memory', metadata: { source: 'chat', key: 42 } });

    const graphStoreCall = invocations.find((i) => i.tool === 'graph-store');
    const props = graphStoreCall!.params.properties as Record<string, unknown>;
    expect(props.metadata).toBe(JSON.stringify({ source: 'chat', key: 42 }));
  });

  it('forwards topics and entities to graph-store', async () => {
    const handler = tools.get('memory-store')!.handler;
    await handler({
      content: 'Test memory',
      topics: ['TypeScript', 'Testing'],
      entities: [{ name: 'John', type: 'person' }],
    });

    const graphStoreCall = invocations.find((i) => i.tool === 'graph-store');
    expect(graphStoreCall!.params.topics).toEqual(['TypeScript', 'Testing']);
    expect(graphStoreCall!.params.entities).toEqual([{ name: 'John', type: 'person' }]);
  });

  it('forwards skipExtraction to graph-store', async () => {
    const handler = tools.get('memory-store')!.handler;
    await handler({ content: 'Test memory', skipExtraction: true });

    const graphStoreCall = invocations.find((i) => i.tool === 'graph-store');
    expect(graphStoreCall!.params.skipExtraction).toBe(true);
  });

  it('forwards importance to graph-store', async () => {
    const handler = tools.get('memory-store')!.handler;
    await handler({ content: 'Test memory', importance: 0.9 });

    const graphStoreCall = invocations.find((i) => i.tool === 'graph-store');
    expect(graphStoreCall!.params.importance).toBe(0.9);
  });

  it('returns error on failure', async () => {
    // Override abilities.invoke to throw
    (mockAbilities.abilities.invoke as any).mockRejectedValueOnce(new Error('Connection failed'));

    const handler = tools.get('memory-store')!.handler;
    const result = await handler({ content: 'Test memory' });

    expect(result.stored).toBe(false);
    expect(result.error).toContain('Connection failed');
  });
});
