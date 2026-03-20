/**
 * Shared test helpers for agent-memory-ability integration tests.
 *
 * Provides a preconfigured KadiClient, SignalAbilities wrapper,
 * config loading, and cleanup utilities.
 *
 * Architecture: agent-memory-ability loads graph-ability natively (in-process).
 * The memory-* tools delegate to graph-* tools, which in turn call broker-based
 * tools (graph-command, graph-query, create-embedding, graph-chat).
 *
 * To avoid requiring graph-ability as a separate broker agent, the test helper
 * patches `invokeRemote` on the test client to try local tool handlers first:
 *   1. Test client's own tools (memory-* tools)
 *   2. Graph-ability's in-process tools (graph-* tools)
 *   3. Broker (arcade-*, create-*, chat-* from arcadedb-ability / model-manager)
 *
 * Graph-ability's own client is also patched so its internal invokeRemote calls
 * (for graph-command etc.) route through the test client's broker connection.
 *
 * All integration tests require:
 *   - KADI broker running (wss://broker.kadi.build/kadi or BROKER_URL env)
 *   - arcadedb-ability connected to broker (provides graph-command, graph-query)
 *   - model-manager connected to broker (provides create-embedding, graph-chat)
 *   - ArcadeDB container running
 *   - Valid API keys in secrets.toml "models" vault
 *
 * NOTE: graph-ability does NOT need to be on the broker — it's loaded in-process.
 */

import { KadiClient } from '@kadi.build/core';

import { loadMemoryConfigWithVault, type MemoryConfig } from '../../src/lib/config.js';
import { registerStoreTool } from '../../src/tools/store.js';
import { registerRecallTool } from '../../src/tools/recall.js';
import { registerContextTool } from '../../src/tools/context.js';
import { registerRelateTool } from '../../src/tools/relate.js';
import { registerForgetTool } from '../../src/tools/forget.js';
import { registerConversationsTool } from '../../src/tools/conversations.js';
import { registerSummarizeTool } from '../../src/tools/summarize.js';

import type { SignalAbilities } from '@kadi.build/graph-ability';
// Importing graph-ability's default export gives us its in-process KadiClient
// with all 10 graph-* tools already registered at module level.
import graphAbilityClient from '@kadi.build/graph-ability';
import { MEMORY_SCHEMA } from '../../src/index.js';

export const BROKER_URL = process.env.BROKER_URL ?? 'wss://broker.kadi.build/kadi';
export const TEST_PREFIX = `AMEM_TEST_${Date.now()}`;

export interface TestContext {
  client: KadiClient;
  config: MemoryConfig;
  abilities: SignalAbilities;
  database: string;
}

/**
 * Create and connect a KadiClient for integration tests.
 *
 * Sets up the full invocation chain:
 *   memory-store → graph-store (local) → graph-command (broker)
 *
 * Patches invokeRemote on both the test client and graph-ability's client
 * so that local tools are resolved in-process and only broker tools go remote.
 */
export async function createTestContext(testName: string): Promise<TestContext> {
  const client = new KadiClient({
    name: `agent-memory-${testName}`,
    version: '0.0.1',
    brokers: { default: { url: BROKER_URL } },
  });

  const config = await loadMemoryConfigWithVault(client);

  if (!config.apiKey) {
    throw new Error(
      'MEMORY_API_KEY not found — ensure secrets.toml has the key in the "models" vault, ' +
      'or set the MEMORY_API_KEY env var.',
    );
  }

  const database = config.database;

  // Connect to broker
  await client.connect();

  console.log(`[${testName}] Connected to broker: ${BROKER_URL}`);
  console.log(`[${testName}] Database: ${database}`);

  // ── Patch invokeRemote for local tool routing ──────────────────────
  //
  // Problem: invokeRemote() always goes to the broker. But graph-ability
  // is loaded in-process (not on the broker). We need memory tools to
  // find graph-* tools locally, and graph-* tools to reach arcade-* via broker.
  //
  // Solution:
  //   1. Save the real broker-bound invokeRemote
  //   2. Redirect graph-ability's invokeRemote → broker (it's disconnected)
  //   3. Patch test client's invokeRemote to: try local → try graph → broker

  const brokerInvoke = client.invokeRemote.bind(client);

  // Graph-ability's own client was created at import time but never connected.
  // Redirect its invokeRemote to the test client's real broker connection.
  (graphAbilityClient as any).invokeRemote = brokerInvoke;

  // Get tool bridges for local invocation (bridges look up tools at call time)
  const graphBridge = graphAbilityClient.createToolBridge();
  const clientBridge = client.createToolBridge();

  // Patch test client's invokeRemote: try local memory tools → graph tools → broker
  (client as any).invokeRemote = async function patchedInvokeRemote<T = unknown>(
    toolName: string,
    params: unknown,
    options?: any,
  ): Promise<T> {
    // a. Try memory-* tools (registered on this test client)
    try {
      return (await clientBridge.executeToolHandler(toolName, params)) as T;
    } catch {
      // Tool not found on test client — continue
    }

    // b. Try graph-* tools (registered on graph-ability's in-process client)
    try {
      return (await graphBridge.executeToolHandler(toolName, params)) as T;
    } catch {
      // Tool not found on graph-ability — continue
    }

    // c. Fall back to broker (graph-command, graph-query, create-embedding, graph-chat)
    return brokerInvoke<T>(toolName, params, options);
  };

  // ── Register Memory schema ────────────────────────────────────────
  // graph-schema-register is now reachable locally via graphBridge
  try {
    await client.invokeRemote('graph-schema-register', {
      name: MEMORY_SCHEMA.name,
      vertexTypes: MEMORY_SCHEMA.vertexTypes,
      edgeTypes: MEMORY_SCHEMA.edgeTypes,
      entityTypes: MEMORY_SCHEMA.entityTypes,
      database,
    });
    console.log(`[${testName}] Memory schema registered`);
  } catch (err: any) {
    console.warn(`[${testName}] Schema registration warning:`, err?.message ?? err);
  }

  // abilities.invoke routes through the patched invokeRemote
  const abilities: SignalAbilities = {
    invoke: <T>(tool: string, params: Record<string, unknown>) =>
      client.invokeRemote(tool, params) as Promise<T>,
  };

  // ── Register all 7 memory-* tools ─────────────────────────────────
  // These tools close over abilities, which routes through the patched invokeRemote.
  registerStoreTool(client, config, abilities);
  registerRecallTool(client, config, abilities);
  registerContextTool(client, config, abilities);
  registerRelateTool(client, config, abilities);
  registerForgetTool(client, config, abilities);
  registerConversationsTool(client, config, abilities);
  registerSummarizeTool(client, config, abilities);

  console.log(`[${testName}] 7 tools registered`);

  return { client, config, abilities, database };
}

/**
 * Create a tool bridge for invoking locally-registered tools.
 *
 * Since client.invokeRemote is patched in createTestContext to try
 * local tools first, the bridge simply delegates to invokeRemote.
 */
export function createToolBridge(client: KadiClient) {
  return {
    async invoke(toolName: string, params: Record<string, unknown>): Promise<any> {
      return client.invokeRemote(toolName, params);
    },
  };
}

/**
 * Clean up test memories by content prefix.
 */
export async function cleanupTestMemories(
  abilities: SignalAbilities,
  database: string,
  contentPrefix: string,
): Promise<void> {
  try {
    await abilities.invoke('graph-command', {
      database,
      command: `DELETE VERTEX Memory WHERE content LIKE '${contentPrefix}%'`,
    });
  } catch {
    // Ignore cleanup errors
  }
}

/**
 * Clean up test conversations.
 */
export async function cleanupTestConversations(
  abilities: SignalAbilities,
  database: string,
  conversationPrefix: string,
): Promise<void> {
  try {
    await abilities.invoke('graph-command', {
      database,
      command: `DELETE VERTEX Conversation WHERE conversationId LIKE '${conversationPrefix}%'`,
    });
  } catch {
    // Ignore cleanup errors
  }
}

/**
 * Clean up all test data.
 */
export async function cleanupAll(
  abilities: SignalAbilities,
  database: string,
  prefix: string,
): Promise<void> {
  await cleanupTestMemories(abilities, database, prefix);
  await cleanupTestConversations(abilities, database, prefix);

  // Also clean orphaned topics/entities from tests
  try {
    await abilities.invoke('graph-command', {
      database,
      command: `DELETE VERTEX Topic WHERE bothE().size() = 0`,
    });
    await abilities.invoke('graph-command', {
      database,
      command: `DELETE VERTEX Entity WHERE bothE().size() = 0`,
    });
  } catch {
    // Ignore
  }
}
