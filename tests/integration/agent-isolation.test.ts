/**
 * Integration test: Agent Isolation
 *
 * Tests: Store as agent-A, recall as agent-B → empty results.
 * Verifies that the agent filter on memory-recall properly isolates data.
 *
 * Requires full infrastructure: broker + arcadedb-ability + model-manager + graph-ability
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';

import {
  createTestContext,
  createToolBridge,
  cleanupAll,
  TEST_PREFIX,
  type TestContext,
} from './helpers.js';

const PREFIX = `${TEST_PREFIX}_ISO`;

describe('agent isolation', { timeout: 120_000 }, () => {
  let ctx: TestContext;
  let bridge: ReturnType<typeof createToolBridge>;

  const agentA = `${PREFIX}_agent_A`;
  const agentB = `${PREFIX}_agent_B`;

  beforeAll(async () => {
    ctx = await createTestContext('agent-isolation');
    bridge = createToolBridge(ctx.client);

    // Pre-cleanup
    await cleanupAll(ctx.abilities, ctx.database, PREFIX);
  });

  afterAll(async () => {
    await cleanupAll(ctx.abilities, ctx.database, PREFIX);
    await ctx.client.disconnect();
  });

  it('stores memories as agent-A', async () => {
    const result1 = await bridge.invoke('memory-store', {
      content: `${PREFIX} Agent A's private memory about project alpha`,
      agent: agentA,
      skipExtraction: true,
      importance: 0.7,
    });
    expect(result1.stored).toBe(true);
    expect(result1.agent).toBe(agentA);

    const result2 = await bridge.invoke('memory-store', {
      content: `${PREFIX} Agent A's second private memory about beta testing`,
      agent: agentA,
      skipExtraction: true,
      importance: 0.6,
    });
    expect(result2.stored).toBe(true);

    console.log('[isolation] Stored 2 memories as agent-A');
  });

  it('agent-A can recall its own memories', async () => {
    const result = await bridge.invoke('memory-recall', {
      query: 'project alpha beta testing',
      agent: agentA,
      limit: 10,
    });

    expect(result.results).toBeDefined();
    const found = (result.results ?? []).filter(
      (r: any) => r.content?.includes(PREFIX),
    );
    expect(found.length).toBeGreaterThanOrEqual(1);

    console.log('[isolation] Agent-A recalled', found.length, 'own memories');
  });

  it('agent-B cannot see agent-A memories', async () => {
    const result = await bridge.invoke('memory-recall', {
      query: 'project alpha beta testing',
      agent: agentB,
      limit: 10,
    });

    // Agent-B should get 0 results matching our test prefix
    const found = (result.results ?? []).filter(
      (r: any) => r.content?.includes(PREFIX),
    );
    expect(found.length).toBe(0);

    console.log('[isolation] Agent-B recalled', found.length, 'memories (expected 0)');
  });

  it('agent-B stores and retrieves its own memories independently', async () => {
    // Store as agent-B
    const storeResult = await bridge.invoke('memory-store', {
      content: `${PREFIX} Agent B's independent memory about database optimization`,
      agent: agentB,
      skipExtraction: true,
      importance: 0.5,
    });
    expect(storeResult.stored).toBe(true);

    // Recall as agent-B — should only see agent-B's memory
    const recallResult = await bridge.invoke('memory-recall', {
      query: 'database optimization',
      agent: agentB,
      limit: 10,
    });

    const bMemories = (recallResult.results ?? []).filter(
      (r: any) => r.content?.includes(PREFIX),
    );
    expect(bMemories.length).toBeGreaterThanOrEqual(1);

    // Verify none of them are agent-A's
    for (const mem of bMemories) {
      expect(mem.properties?.agent ?? mem.agent).not.toBe(agentA);
    }

    console.log('[isolation] Agent-B has', bMemories.length, 'independent memories');
  });

  it('cleanup: forget agent-A memories', async () => {
    const result = await bridge.invoke('memory-forget', {
      agent: agentA,
      confirm: true,
      cascade: true,
    });
    expect(result.deleted).toBe(true);
    console.log('[isolation] Cleaned up agent-A:', result.memoriesRemoved, 'memories');
  });

  it('cleanup: forget agent-B memories', async () => {
    const result = await bridge.invoke('memory-forget', {
      agent: agentB,
      confirm: true,
      cascade: true,
    });
    expect(result.deleted).toBe(true);
    console.log('[isolation] Cleaned up agent-B:', result.memoriesRemoved, 'memories');
  });
});
