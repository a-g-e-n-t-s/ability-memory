/**
 * Unit tests for memory-forget cascade logic.
 *
 * Verifies:
 *   - Safety guard (confirm: true required)
 *   - At least one filter required
 *   - Single RID deletion via graph-delete
 *   - Bulk deletion by agent/conversationId/olderThan
 *   - Domain-specific cascade: orphaned Topic/Entity removal
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { KadiClient } from '@kadi.build/core';

import type { MemoryConfig } from '../../src/lib/config.js';
import type { SignalAbilities } from '../../src/lib/graph-types.js';
import { registerForgetTool } from '../../src/tools/forget.js';

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

function createMockAbilities(options: {
  memoryRids?: string[];
  orphanTopicRids?: string[];
  orphanEntityRids?: string[];
} = {}): {
  abilities: SignalAbilities;
  invokeCalls: Array<{ tool: string; params: Record<string, unknown> }>;
  deletedRids: string[];
} {
  const invokeCalls: Array<{ tool: string; params: Record<string, unknown> }> = [];
  const deletedRids: string[] = [];

  const memoryRids = options.memoryRids ?? [];
  const orphanTopicRids = options.orphanTopicRids ?? [];
  const orphanEntityRids = options.orphanEntityRids ?? [];

  const abilities: SignalAbilities = {
    invoke: vi.fn(async <T>(tool: string, params: Record<string, unknown>): Promise<T> => {
      invokeCalls.push({ tool, params });

      if (tool === 'graph-delete') {
        deletedRids.push(params.rid as string);
        return { success: true, deleted: params.rid, orphansDeleted: 0 } as T;
      }

      if (tool === 'graph-query') {
        const query = params.query as string;

        if (query.includes('FROM Memory WHERE')) {
          // Return memory RIDs for bulk deletion
          return {
            success: true,
            result: memoryRids.map((rid) => ({ '@rid': rid })),
          } as T;
        }

        if (query.includes('FROM Topic WHERE bothE()')) {
          // Return orphaned topics
          return {
            success: true,
            result: orphanTopicRids.map((rid) => ({ '@rid': rid })),
          } as T;
        }

        if (query.includes('FROM Entity WHERE bothE()')) {
          // Return orphaned entities
          return {
            success: true,
            result: orphanEntityRids.map((rid) => ({ '@rid': rid })),
          } as T;
        }

        return { success: true, result: [] } as T;
      }

      return { success: true } as T;
    }),
  };

  return { abilities, invokeCalls, deletedRids };
}

// ── Tests ─────────────────────────────────────────────────────────────

describe('memory-forget cascade', () => {
  let config: MemoryConfig;

  beforeEach(() => {
    config = createMockConfig();
  });

  it('registers a tool named memory-forget', () => {
    const mock = createMockClient();
    const mockAb = createMockAbilities();
    registerForgetTool(mock.client, config, mockAb.abilities);
    expect(mock.registeredTools.has('memory-forget')).toBe(true);
  });

  it('rejects when confirm is false', async () => {
    const mock = createMockClient();
    const mockAb = createMockAbilities();
    registerForgetTool(mock.client, config, mockAb.abilities);
    const handler = mock.registeredTools.get('memory-forget')!.handler;

    const result = await handler({ rid: '#20:0', confirm: false });
    expect(result.deleted).toBe(false);
    expect(result.error).toContain('Safety guard');
  });

  it('rejects when no filters provided', async () => {
    const mock = createMockClient();
    const mockAb = createMockAbilities();
    registerForgetTool(mock.client, config, mockAb.abilities);
    const handler = mock.registeredTools.get('memory-forget')!.handler;

    const result = await handler({ confirm: true });
    expect(result.deleted).toBe(false);
    expect(result.error).toContain('At least one filter');
  });

  it('deletes single memory by RID via graph-delete', async () => {
    const mock = createMockClient();
    const mockAb = createMockAbilities();
    registerForgetTool(mock.client, config, mockAb.abilities);
    const handler = mock.registeredTools.get('memory-forget')!.handler;

    const result = await handler({ rid: '#20:0', confirm: true });
    expect(result.deleted).toBe(true);
    expect(result.memoriesRemoved).toBe(1);
    expect(mockAb.deletedRids).toContain('#20:0');

    // Verify graph-delete was called (not direct graph-command)
    const graphDeleteCalls = mockAb.invokeCalls.filter((i) => i.tool === 'graph-delete');
    expect(graphDeleteCalls.length).toBe(1);
    expect(graphDeleteCalls[0].params.rid).toBe('#20:0');
  });

  it('deletes multiple memories by agent filter', async () => {
    const mock = createMockClient();
    const mockAb = createMockAbilities({ memoryRids: ['#20:0', '#20:1', '#20:2'] });
    registerForgetTool(mock.client, config, mockAb.abilities);
    const handler = mock.registeredTools.get('memory-forget')!.handler;

    const result = await handler({ agent: 'old-agent', confirm: true });
    expect(result.deleted).toBe(true);
    expect(result.memoriesRemoved).toBe(3);
    expect(mockAb.deletedRids).toEqual(['#20:0', '#20:1', '#20:2']);
  });

  it('deletes memories by conversationId', async () => {
    const mock = createMockClient();
    const mockAb = createMockAbilities({ memoryRids: ['#20:5', '#20:6'] });
    registerForgetTool(mock.client, config, mockAb.abilities);
    const handler = mock.registeredTools.get('memory-forget')!.handler;

    const result = await handler({ conversationId: 'conv-old', confirm: true });
    expect(result.deleted).toBe(true);
    expect(result.memoriesRemoved).toBe(2);

    // Verify query included conversationId filter
    const queryCall = mockAb.invokeCalls.find(
      (i) => i.tool === 'graph-query' && (i.params.query as string).includes('Memory WHERE'),
    );
    expect(queryCall).toBeDefined();
    expect((queryCall!.params.query as string)).toContain('conversationId');
  });

  it('deletes memories older than date', async () => {
    const mock = createMockClient();
    const mockAb = createMockAbilities({ memoryRids: ['#20:10'] });
    registerForgetTool(mock.client, config, mockAb.abilities);
    const handler = mock.registeredTools.get('memory-forget')!.handler;

    const result = await handler({ olderThan: '2025-01-01T00:00:00.000Z', confirm: true });
    expect(result.deleted).toBe(true);

    const queryCall = mockAb.invokeCalls.find(
      (i) => i.tool === 'graph-query' && (i.params.query as string).includes('Memory WHERE'),
    );
    expect((queryCall!.params.query as string)).toContain("timestamp < '2025-01-01T00:00:00.000Z'");
  });

  it('cascade removes orphaned Topics', async () => {
    const mock = createMockClient();
    const mockAb = createMockAbilities({
      orphanTopicRids: ['#30:0', '#30:1'],
    });
    registerForgetTool(mock.client, config, mockAb.abilities);
    const handler = mock.registeredTools.get('memory-forget')!.handler;

    const result = await handler({ rid: '#20:0', confirm: true, cascade: true });
    expect(result.deleted).toBe(true);
    expect(result.orphansRemoved).toBe(2);

    // Should have deleted: 1 memory + 2 orphan topics
    expect(mockAb.deletedRids).toContain('#20:0');
    expect(mockAb.deletedRids).toContain('#30:0');
    expect(mockAb.deletedRids).toContain('#30:1');
  });

  it('cascade removes orphaned Entities', async () => {
    const mock = createMockClient();
    const mockAb = createMockAbilities({
      orphanEntityRids: ['#40:0'],
    });
    registerForgetTool(mock.client, config, mockAb.abilities);
    const handler = mock.registeredTools.get('memory-forget')!.handler;

    const result = await handler({ rid: '#20:0', confirm: true, cascade: true });
    expect(result.deleted).toBe(true);
    expect(result.orphansRemoved).toBe(1);
    expect(mockAb.deletedRids).toContain('#40:0');
  });

  it('cascade removes both orphaned Topics and Entities', async () => {
    const mock = createMockClient();
    const mockAb = createMockAbilities({
      orphanTopicRids: ['#30:0'],
      orphanEntityRids: ['#40:0', '#40:1'],
    });
    registerForgetTool(mock.client, config, mockAb.abilities);
    const handler = mock.registeredTools.get('memory-forget')!.handler;

    const result = await handler({ rid: '#20:0', confirm: true, cascade: true });
    expect(result.deleted).toBe(true);
    expect(result.memoriesRemoved).toBe(1);
    expect(result.orphansRemoved).toBe(3);
  });

  it('no cascade by default', async () => {
    const mock = createMockClient();
    const mockAb = createMockAbilities({
      orphanTopicRids: ['#30:0'],
    });
    registerForgetTool(mock.client, config, mockAb.abilities);
    const handler = mock.registeredTools.get('memory-forget')!.handler;

    const result = await handler({ rid: '#20:0', confirm: true });
    expect(result.orphansRemoved).toBe(0);

    // Should not have queried for orphans
    const orphanQueries = mockAb.invokeCalls.filter(
      (i) => i.tool === 'graph-query' && (i.params.query as string).includes('bothE()'),
    );
    expect(orphanQueries.length).toBe(0);
  });

  it('cascade queries use bothE().size() = 0', async () => {
    const mock = createMockClient();
    const mockAb = createMockAbilities({ orphanTopicRids: [], orphanEntityRids: [] });
    registerForgetTool(mock.client, config, mockAb.abilities);
    const handler = mock.registeredTools.get('memory-forget')!.handler;

    await handler({ rid: '#20:0', confirm: true, cascade: true });

    const orphanQueries = mockAb.invokeCalls.filter(
      (i) => i.tool === 'graph-query' && (i.params.query as string).includes('bothE()'),
    );
    expect(orphanQueries.length).toBe(2);
    expect((orphanQueries[0].params.query as string)).toContain('Topic WHERE bothE().size() = 0');
    expect((orphanQueries[1].params.query as string)).toContain('Entity WHERE bothE().size() = 0');
  });

  it('handles errors gracefully', async () => {
    const mock = createMockClient();
    const mockAb = createMockAbilities();
    (mockAb.abilities.invoke as any).mockRejectedValueOnce(new Error('DB connection lost'));
    registerForgetTool(mock.client, config, mockAb.abilities);
    const handler = mock.registeredTools.get('memory-forget')!.handler;

    const result = await handler({ rid: '#20:0', confirm: true });
    expect(result.deleted).toBe(false);
    expect(result.error).toContain('DB connection lost');
  });
});
