/**
 * Integration test: Full Lifecycle through graph-ability
 *
 * Tests: store → recall → relate → forget — all through graph-ability tools.
 * Validates the full chain: memory-* → graph-* → arcadedb/model-manager.
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

const PREFIX = `${TEST_PREFIX}_FLC`;

describe('full lifecycle through graph-ability', { timeout: 120_000 }, () => {
  let ctx: TestContext;
  let bridge: ReturnType<typeof createToolBridge>;
  let memory1Rid: string;
  let memory2Rid: string;

  beforeAll(async () => {
    ctx = await createTestContext('full-lifecycle');
    bridge = createToolBridge(ctx.client);

    // Pre-cleanup
    await cleanupAll(ctx.abilities, ctx.database, PREFIX);
  });

  afterAll(async () => {
    await cleanupAll(ctx.abilities, ctx.database, PREFIX);
    await ctx.client.disconnect();
  });

  it('stores first memory', async () => {
    const result = await bridge.invoke('memory-store', {
      content: `${PREFIX} Kubernetes deployment strategies include rolling updates and blue-green deployments`,
      agent: 'full-lifecycle-agent',
      topics: ['Kubernetes', 'deployment'],
      entities: [{ name: 'Kubernetes', type: 'tool' }],
      importance: 0.8,
      skipExtraction: true,
    });

    expect(result.stored).toBe(true);
    expect(result.rid).toBeDefined();
    memory1Rid = result.rid;

    console.log('[full-lifecycle] Stored memory 1:', memory1Rid);
  });

  it('stores second memory', async () => {
    const result = await bridge.invoke('memory-store', {
      content: `${PREFIX} Docker containers provide isolation for microservices. Kubernetes orchestrates them.`,
      agent: 'full-lifecycle-agent',
      topics: ['Docker', 'Kubernetes'],
      entities: [
        { name: 'Docker', type: 'tool' },
        { name: 'Kubernetes', type: 'tool' },
      ],
      importance: 0.7,
      skipExtraction: true,
    });

    expect(result.stored).toBe(true);
    expect(result.rid).toBeDefined();
    memory2Rid = result.rid;

    console.log('[full-lifecycle] Stored memory 2:', memory2Rid);
  });

  it('recalls memories via hybrid search', async () => {
    const result = await bridge.invoke('memory-recall', {
      query: 'Kubernetes deployment strategies',
      agent: 'full-lifecycle-agent',
      limit: 10,
    });

    expect(result.results).toBeDefined();
    expect(result.count).toBeGreaterThan(0);

    const found = (result.results ?? []).filter(
      (r: any) => r.content?.includes(PREFIX),
    );
    expect(found.length).toBeGreaterThanOrEqual(1);

    console.log('[full-lifecycle] Recalled', result.count, 'memories');
  });

  it('relates the two memories', async () => {
    const result = await bridge.invoke('memory-relate', {
      fromRid: memory1Rid,
      toRid: memory2Rid,
      relationship: 'complements',
      weight: 0.9,
    });

    expect(result.created).toBe(true);
    expect(result.from).toBe(memory1Rid);
    expect(result.to).toBe(memory2Rid);
    expect(result.relationship).toBe('complements');

    console.log('[full-lifecycle] Created relationship between memories');
  });

  it('verifies the relationship via graph query', async () => {
    const queryResult = await ctx.abilities.invoke<{
      success: boolean;
      result?: Array<Record<string, unknown>>;
    }>('graph-query', {
      database: ctx.database,
      query: `SELECT expand(bothE('RelatedTo')) FROM ${memory1Rid}`,
    });

    expect(queryResult.success).toBe(true);
    expect(queryResult.result?.length).toBeGreaterThanOrEqual(1);

    console.log('[full-lifecycle] Verified relationship in graph');
  });

  it('forgets first memory', async () => {
    const result = await bridge.invoke('memory-forget', {
      rid: memory1Rid,
      confirm: true,
      cascade: false,
    });

    expect(result.deleted).toBe(true);
    expect(result.memoriesRemoved).toBe(1);

    console.log('[full-lifecycle] Forgot memory 1');
  });

  it('forgets second memory with cascade', async () => {
    const result = await bridge.invoke('memory-forget', {
      rid: memory2Rid,
      confirm: true,
      cascade: true,
    });

    expect(result.deleted).toBe(true);
    expect(result.memoriesRemoved).toBe(1);

    console.log('[full-lifecycle] Forgot memory 2 with cascade, orphans removed:', result.orphansRemoved);
  });

  it('confirms memories are gone', async () => {
    const recallResult = await bridge.invoke('memory-recall', {
      query: PREFIX,
      agent: 'full-lifecycle-agent',
      limit: 10,
    });

    const found = (recallResult.results ?? []).filter(
      (r: any) => r.content?.includes(PREFIX),
    );
    expect(found.length).toBe(0);

    console.log('[full-lifecycle] Confirmed all memories deleted');
  });
});
