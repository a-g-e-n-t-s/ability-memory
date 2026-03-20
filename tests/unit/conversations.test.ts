/**
 * Unit tests for memory-conversations tool.
 *
 * Verifies:
 *   - Conversation listing with agent filter
 *   - Since filter for date-based queries
 *   - Duration calculation
 *   - Limit bounds
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { KadiClient } from '@kadi.build/core';

import type { MemoryConfig } from '../../src/lib/config.js';
import type { SignalAbilities } from '../../src/lib/graph-types.js';
import { registerConversationsTool } from '../../src/tools/conversations.js';

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
  schema: any;
  handler: (input: any) => Promise<any>;
}

function createMockClient(): {
  client: KadiClient;
  registeredTools: Map<string, ToolRegistration>;
} {
  const registeredTools = new Map<string, ToolRegistration>();

  const client = {
    registerTool: vi.fn((schema: any, handler: any) => {
      registeredTools.set(schema.name, { schema, handler });
    }),
  } as unknown as KadiClient;

  return { client, registeredTools };
}

function createMockAbilities(queryResponse?: any): {
  abilities: SignalAbilities;
  invokeCalls: Array<{ tool: string; params: Record<string, unknown> }>;
} {
  const invokeCalls: Array<{ tool: string; params: Record<string, unknown> }> = [];

  const defaultResponse = {
    success: true,
    result: [
      {
        conversationId: 'conv-001',
        startTime: '2026-01-01T10:00:00.000Z',
        endTime: '2026-01-01T10:30:00.000Z',
        memoryCount: 5,
        summary: 'Discussion about project setup',
      },
      {
        conversationId: 'conv-002',
        startTime: '2026-01-02T14:00:00.000Z',
        endTime: '2026-01-02T15:15:00.000Z',
        memoryCount: 12,
        summary: null,
      },
    ],
  };

  const abilities: SignalAbilities = {
    invoke: vi.fn(async <T>(tool: string, params: Record<string, unknown>): Promise<T> => {
      invokeCalls.push({ tool, params });
      return (queryResponse ?? defaultResponse) as T;
    }),
  };

  return { abilities, invokeCalls };
}

// ── Tests ─────────────────────────────────────────────────────────────

describe('memory-conversations tool', () => {
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
    registerConversationsTool(mock.client, config, mockAbilities.abilities);
  });

  it('registers a tool named memory-conversations', () => {
    expect(tools.has('memory-conversations')).toBe(true);
  });

  it('queries Conversation vertex type with agent filter', async () => {
    const handler = tools.get('memory-conversations')!.handler;
    await handler({});

    expect(invocations.length).toBe(1);
    const call = invocations[0];
    expect(call.tool).toBe('graph-query');
    expect((call.params.query as string)).toContain('FROM Conversation');
    expect((call.params.query as string)).toContain("agent = 'test-agent'");
  });

  it('uses provided agent', async () => {
    const handler = tools.get('memory-conversations')!.handler;
    await handler({ agent: 'custom-agent' });

    const call = invocations[0];
    expect((call.params.query as string)).toContain("agent = 'custom-agent'");
  });

  it('adds since filter when provided', async () => {
    const handler = tools.get('memory-conversations')!.handler;
    await handler({ since: '2026-01-01T00:00:00.000Z' });

    const call = invocations[0];
    expect((call.params.query as string)).toContain("startTime >= '2026-01-01T00:00:00.000Z'");
  });

  it('applies limit to query', async () => {
    const handler = tools.get('memory-conversations')!.handler;
    await handler({ limit: 5 });

    const call = invocations[0];
    expect((call.params.query as string)).toContain('LIMIT 5');
  });

  it('defaults limit to 20', async () => {
    const handler = tools.get('memory-conversations')!.handler;
    await handler({});

    const call = invocations[0];
    expect((call.params.query as string)).toContain('LIMIT 20');
  });

  it('clamps limit to range 1-100', async () => {
    const handler = tools.get('memory-conversations')!.handler;
    await handler({ limit: 200 });

    const call = invocations[0];
    expect((call.params.query as string)).toContain('LIMIT 100');
  });

  it('orders by startTime DESC', async () => {
    const handler = tools.get('memory-conversations')!.handler;
    await handler({});

    const call = invocations[0];
    expect((call.params.query as string)).toContain('ORDER BY startTime DESC');
  });

  it('calculates duration for conversations with start and end times', async () => {
    const handler = tools.get('memory-conversations')!.handler;
    const result = await handler({});

    expect(result.conversations[0].duration).toBe('30m');
    expect(result.conversations[1].duration).toBe('1h 15m');
  });

  it('returns conversation count', async () => {
    const handler = tools.get('memory-conversations')!.handler;
    const result = await handler({});

    expect(result.count).toBe(2);
    expect(result.agent).toBe('test-agent');
  });

  it('handles empty results', async () => {
    const mock = createMockClient();
    const emptyAbilities = createMockAbilities({ success: true, result: [] });
    registerConversationsTool(mock.client, config, emptyAbilities.abilities);
    const handler = mock.registeredTools.get('memory-conversations')!.handler;
    const result = await handler({});

    expect(result.conversations).toEqual([]);
    expect(result.count).toBe(0);
  });

  it('handles query failure', async () => {
    const mock = createMockClient();
    const failAbilities = createMockAbilities({ success: false, error: 'Database error' });
    registerConversationsTool(mock.client, config, failAbilities.abilities);
    const handler = mock.registeredTools.get('memory-conversations')!.handler;
    const result = await handler({});

    expect(result.success).toBe(false);
    expect(result.error).toContain('Database error');
  });

  it('handles missing summary gracefully', async () => {
    const handler = tools.get('memory-conversations')!.handler;
    const result = await handler({});

    // Second conversation has null summary
    expect(result.conversations[1].summary).toBeUndefined();
  });

  it('uses database from config', async () => {
    const handler = tools.get('memory-conversations')!.handler;
    await handler({});

    const call = invocations[0];
    expect(call.params.database).toBe('test_memory');
  });
});
