/**
 * agent-memory-ability — Domain layer for conversational agent memory.
 *
 * Thin wrapper over graph-ability providing 7 memory-* tools with enforced
 * Memory schema defaults, agent isolation, conversation management,
 * cascade deletion, and LLM summarization.
 *
 * Supports three deployment modes:
 *   1. Native library  — `loadNative('agent-memory-ability')` → tools available in-process
 *   2. Remote library   — `invokeRemote('memory-store', ...)` via broker
 *   3. CLI `kadi run`   — connects to broker and serves tools to other agents
 *
 * Credentials are loaded from the "models" vault via secret-ability at startup.
 * No .env files — uses vault → config.yml → built-in defaults.
 *
 * Boot sequence (all modes):
 *   1. Load config with vault credentials (async, top-level await)
 *   2. loadNative('graph-ability') — import the core graph engine
 *   3. Register all 7 memory-* tools
 *   4. (CLI only) Register schema → connect to broker → serve
 *
 * Tools:
 *   - memory-store         — Store a memory (enforces vertexType=Memory, auto agent+timestamp)
 *   - memory-recall        — Search memories (enforces vertexType=Memory, agent filter, 3-signal)
 *   - memory-context       — Graph traversal context around a memory
 *   - memory-relate        — Create typed edges between vertices
 *   - memory-forget        — Delete memories with optional cascade of orphans
 *   - memory-conversations — List conversation sessions
 *   - memory-summarize     — Generate conversation summary via LLM
 */

import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

import { KadiClient, type LoadedAbility } from '@kadi.build/core';

import { loadMemoryConfigWithVault, type MemoryConfig } from './lib/config.js';
import { registerStoreTool } from './tools/store.js';
import { registerRecallTool } from './tools/recall.js';
import { registerContextTool } from './tools/context.js';
import { registerRelateTool } from './tools/relate.js';
import { registerForgetTool } from './tools/forget.js';
import { registerConversationsTool } from './tools/conversations.js';
import { registerSummarizeTool } from './tools/summarize.js';

import type {
  SchemaDefinition,
  VertexTypeDef,
  EdgeTypeDef,
  SignalAbilities,
} from './lib/graph-types.js';

import {
  TOPIC_VERTEX,
  ENTITY_VERTEX,
  COMMON_EDGE_TYPES,
  DEFAULT_ENTITY_TYPES,
} from './lib/graph-types.js';

// ── Read broker config from agent.json ────────────────────────────────

const __dirname = dirname(fileURLToPath(import.meta.url));

function loadAgentJson(): Record<string, any> {
  let dir = __dirname;
  while (true) {
    try {
      const candidate = join(dir, 'agent.json');
      const content = readFileSync(candidate, 'utf8');
      return JSON.parse(content);
    } catch {
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  }
  return {};
}

function resolveBrokerUrl(): string {
  if (process.env.BROKER_URL) return process.env.BROKER_URL;

  const agent = loadAgentJson();
  const brokers = agent.brokers ?? {};

  // Prefer remote → default (legacy) → local
  for (const key of ['remote', 'default', 'local']) {
    const entry = brokers[key];
    if (typeof entry === 'string') return entry;
    if (entry?.url) return entry.url;
  }

  return 'ws://localhost:8080/kadi';
}

// ── Build the client ──────────────────────────────────────────────────

const brokerUrl = resolveBrokerUrl();
const agentJson = loadAgentJson();

const client = new KadiClient({
  name: agentJson.name ?? 'agent-memory-ability',
  version: agentJson.version ?? '1.0.0',
  brokers: {
    default: { url: brokerUrl },
  },
});

// ── Schema Definitions ────────────────────────────────────────────────

/**
 * Memory schema — vertex type for storing agent memories.
 */
const MEMORY_VERTEX: VertexTypeDef = {
  name: 'Memory',
  properties: {
    content: 'STRING',
    agent: 'STRING',
    timestamp: 'DATETIME',
    importance: 'DOUBLE',
    embedding: 'EMBEDDEDLIST',
    conversationId: 'STRING',
    metadata: 'STRING',
  },
  indexes: [
    { property: 'agent', type: 'NOTUNIQUE' },
    { property: 'timestamp', type: 'NOTUNIQUE' },
    { property: 'content', type: 'FULL_TEXT' },
  ],
};

/**
 * Conversation schema — vertex type for tracking conversation sessions.
 */
const CONVERSATION_VERTEX: VertexTypeDef = {
  name: 'Conversation',
  properties: {
    conversationId: 'STRING',
    agent: 'STRING',
    startTime: 'DATETIME',
    endTime: 'DATETIME',
    summary: 'STRING',
    memoryCount: 'INTEGER',
  },
  indexes: [
    { property: 'conversationId', type: 'UNIQUE' },
    { property: 'agent', type: 'NOTUNIQUE' },
  ],
};

/** InConversation edge — links Memory → Conversation. */
const IN_CONVERSATION_EDGE: EdgeTypeDef = {
  name: 'InConversation',
  properties: {},
};

/** REMEMBERED_DURING edge — links Memory → Conversation for temporal context. */
const REMEMBERED_DURING_EDGE: EdgeTypeDef = {
  name: 'REMEMBERED_DURING',
  properties: { timestamp: 'DATETIME' },
};

/**
 * Complete Memory schema definition for graph-schema-register.
 */
export const MEMORY_SCHEMA: SchemaDefinition = {
  name: 'agent-memory',
  vertexTypes: [MEMORY_VERTEX, CONVERSATION_VERTEX, TOPIC_VERTEX, ENTITY_VERTEX],
  edgeTypes: [...COMMON_EDGE_TYPES, IN_CONVERSATION_EDGE, REMEMBERED_DURING_EDGE],
  entityTypes: DEFAULT_ENTITY_TYPES,
};

// ── Async initialization (top-level await) ────────────────────────────
//
// Loads credentials from vault via secret-ability, connects to broker,
// loads graph-ability natively, then registers all 7 memory-* tools.
// By the time `import()` resolves (for native consumers) or `kadi run`
// starts serving, all tools are fully configured and registered.

// 1. Load config with vault credentials
console.log('[agent-memory-ability] Loading configuration…');
const config: MemoryConfig = await loadMemoryConfigWithVault(client);

// 2. Load graph-ability as native dependency (no timeout — batch ops are long-running)
console.log('[agent-memory-ability] Loading graph-ability…');
let graphAbility: LoadedAbility | null = null;
try {
  graphAbility = await client.loadNative('graph-ability', { timeout: 0 });
  console.log('[agent-memory-ability] graph-ability loaded');
} catch (err: any) {
  console.warn(
    '[agent-memory-ability] graph-ability native load failed, continuing:',
    err?.message ?? err,
  );
}

// 3. Build abilities router — all tools go through graph-ability.
//    Long-running tools (graph-batch-store) use timeout:0 to avoid the
//    native transport's default 10-minute timeout.
const LONG_RUNNING_TOOLS = new Set(['graph-batch-store']);
const abilities: SignalAbilities = {
  invoke: <T>(tool: string, params: Record<string, unknown>) => {
    if (!graphAbility) {
      throw new Error('graph-ability not loaded — cannot invoke tools');
    }
    const opts = LONG_RUNNING_TOOLS.has(tool) ? { timeout: 0 } : undefined;
    return graphAbility.invoke<T>(tool, params, opts);
  },
};

// 4. Register all 7 memory-* tools
registerStoreTool(client, config, abilities);
registerRecallTool(client, config, abilities);
registerContextTool(client, config, abilities);
registerRelateTool(client, config, abilities);
registerForgetTool(client, config, abilities);
registerConversationsTool(client, config, abilities);
registerSummarizeTool(client, config, abilities);
console.log('[agent-memory-ability] 7 tools registered');

// ── CLI entry point (kadi run / direct execution) ─────────────────────
//
// When run directly (not imported as a library), connect to broker,
// register schema, and serve. Supports: `kadi run` (broker) or `node dist/index.js stdio`

const isMainModule = import.meta.url === `file://${process.argv[1]}`;
if (isMainModule) {
  const mode = process.argv.includes('stdio') ? 'stdio' : 'broker';
  console.log(`[agent-memory-ability] Starting in ${mode} mode → ${brokerUrl}`);

  if (mode === 'stdio') {
    await client.serve('stdio');
  } else {
    // Broker mode — connect to broker so memory-* tools are discoverable
    try {
      await client.connect();
      console.log(`[agent-memory-ability] Connected to broker: ${brokerUrl}`);
    } catch (err: any) {
      console.warn(
        '[agent-memory-ability] Broker connection failed:',
        err?.message ?? err,
      );
    }

    console.log('[agent-memory-ability] Serving via broker.');

    // Register schema via graph-ability
    try {
      console.log('[agent-memory-ability] Registering Memory schema…');
      const schemaResult = await abilities.invoke('graph-schema-register', {
        name: MEMORY_SCHEMA.name,
        vertexTypes: MEMORY_SCHEMA.vertexTypes,
        edgeTypes: MEMORY_SCHEMA.edgeTypes,
        entityTypes: MEMORY_SCHEMA.entityTypes,
        database: config.database,
      });
      console.log('[agent-memory-ability] Memory schema registered:', schemaResult);
    } catch (err: any) {
      console.warn(
        '[agent-memory-ability] Schema registration deferred:',
        err?.message ?? err,
      );
    }

    // Keep process alive
    await new Promise(() => {});
  }
}

// ── Graceful shutdown ─────────────────────────────────────────────────

function forceExit(): void {
  console.log('[agent-memory-ability] Shutting down…');
  client.disconnect?.().catch(() => {});
  setTimeout(() => {
    console.log('[agent-memory-ability] Force exit');
    process.exit(0);
  }, 3000).unref();
}

process.on('SIGINT', forceExit);
process.on('SIGTERM', forceExit);

// ── Default + library exports ─────────────────────────────────────────

export default client;

export { MEMORY_VERTEX, CONVERSATION_VERTEX };
export { loadMemoryConfig, loadMemoryConfigWithVault, type MemoryConfig } from './lib/config.js';
