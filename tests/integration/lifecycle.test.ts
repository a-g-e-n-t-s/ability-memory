/**
 * Integration test: Full Memory Lifecycle
 *
 * Tests: store → recall → context → summarize → forget (full cycle)
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

const PREFIX = `${TEST_PREFIX}_LC`;

describe('memory lifecycle', { timeout: 120_000 }, () => {
  let ctx: TestContext;
  let bridge: ReturnType<typeof createToolBridge>;
  let storedRid: string;
  const conversationId = `${PREFIX}_conv_${Date.now()}`;

  beforeAll(async () => {
    ctx = await createTestContext('lifecycle');
    bridge = createToolBridge(ctx.client);

    // Pre-cleanup
    await cleanupAll(ctx.abilities, ctx.database, PREFIX);
  });

  afterAll(async () => {
    await cleanupAll(ctx.abilities, ctx.database, PREFIX);
    await ctx.client.disconnect();
  });

  it('stores a memory with extraction and embedding', async () => {
    const result = await bridge.invoke('memory-store', {
      content: `${PREFIX} The team decided to use TypeScript for the new graph-ability project. This is important for type safety.`,
      agent: 'lifecycle-agent',
      conversationId,
      importance: 0.8,
    });

    expect(result.stored).toBe(true);
    expect(result.rid).toBeDefined();
    expect(result.agent).toBe('lifecycle-agent');
    storedRid = result.rid;

    console.log('[lifecycle] Stored memory:', storedRid);
  });

  it('recalls the stored memory via hybrid search', async () => {
    const result = await bridge.invoke('memory-recall', {
      query: 'TypeScript graph ability',
      agent: 'lifecycle-agent',
      limit: 5,
    });

    expect(result.results).toBeDefined();
    expect(result.count).toBeGreaterThan(0);

    const found = result.results.some(
      (r: any) => r.content?.includes(PREFIX),
    );
    expect(found).toBe(true);

    console.log('[lifecycle] Recalled', result.count, 'memories');
  });

  it('gets context around the stored memory', async () => {
    const result = await bridge.invoke('memory-context', {
      query: 'TypeScript project decisions',
      agent: 'lifecycle-agent',
      depth: 2,
      limit: 3,
    });

    expect(result.results || result.found).toBeDefined();

    console.log('[lifecycle] Context result:', JSON.stringify(result).slice(0, 200));
  });

  it('summarizes the conversation', async () => {
    // Store a second memory in the same conversation
    await bridge.invoke('memory-store', {
      content: `${PREFIX} The architecture review approved the 3-layer design: graph-ability core, agent-memory, and docs-memory.`,
      agent: 'lifecycle-agent',
      conversationId,
      importance: 0.7,
    });

    const result = await bridge.invoke('memory-summarize', {
      conversationId,
    });

    expect(result.summarized).toBe(true);
    expect(result.summary).toBeDefined();
    expect(result.summary.length).toBeGreaterThan(0);
    expect(result.memoryCount).toBeGreaterThanOrEqual(2);

    console.log('[lifecycle] Summary:', result.summary);
  });

  it('forgets the memories with cascade', async () => {
    const result = await bridge.invoke('memory-forget', {
      conversationId,
      confirm: true,
      cascade: true,
    });

    expect(result.deleted).toBe(true);
    expect(result.memoriesRemoved).toBeGreaterThanOrEqual(2);

    console.log('[lifecycle] Forgot', result.memoriesRemoved, 'memories, cascaded', result.orphansRemoved, 'orphans');

    // Verify the memories are gone
    const recallResult = await bridge.invoke('memory-recall', {
      query: PREFIX,
      agent: 'lifecycle-agent',
      limit: 10,
    });

    const found = (recallResult.results ?? []).some(
      (r: any) => r.content?.includes(PREFIX),
    );
    expect(found).toBe(false);
  });
});
