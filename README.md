# agent-memory-ability

Domain layer for conversational agent memory in the [KĀDI](https://kadi.build) framework. A thin, opinionated wrapper over [graph-ability](../graph-ability) providing 7 `memory-*` tools with enforced Memory schema defaults, automatic agent isolation, conversation tracking, cascade deletion, and LLM summarization.

## Features

- **7 memory-specific tools** — store, recall, context, relate, forget, conversations, summarize
- **Agent isolation** — every query is automatically scoped to the calling agent
- **Conversation sessions** — group memories by `conversationId`, track duration and count
- **LLM summarization** — generate conversation summaries via `chat-completion`
- **Cascade delete** — forget a memory and automatically clean up orphaned Topics/Entities
- **Three deployment modes** — native library, remote broker ability, or standalone CLI
- **Vault-first credentials** — API keys loaded from the `models` vault via `secret-ability`; no `.env` files
- **Comprehensive test suite** — 58 unit tests + 19 integration tests

## Quick Start

### Install as a KĀDI ability

```bash
kadi install agent-memory-ability
```

### Use as a native library (in-process)

```typescript
import { KadiClient } from '@kadi.build/core';

const client = new KadiClient({ name: 'my-agent', version: '1.0.0' });
const memory = await client.loadNative('agent-memory-ability');

// Store a memory
const stored = await memory.invoke('memory-store', {
  content: 'The user prefers dark mode and uses TypeScript.',
  agent: 'assistant-v1',
  conversationId: 'session-42',
  importance: 0.8,
});
console.log(stored.rid); // e.g. "#12:0"

// Recall memories (hybrid search: semantic + keyword + graph)
const results = await memory.invoke('memory-recall', {
  query: 'what are the user preferences?',
  agent: 'assistant-v1',
});
console.log(results.results);

// Get conversation context via graph traversal
const context = await memory.invoke('memory-context', {
  query: 'user preferences',
  agent: 'assistant-v1',
  depth: 2,
});

// Relate two memories
await memory.invoke('memory-relate', {
  fromRid: '#12:0',
  toRid: '#12:5',
  relationship: 'contradicts',
  weight: 0.9,
});

// List conversations
const convos = await memory.invoke('memory-conversations', {
  agent: 'assistant-v1',
  limit: 10,
});

// Summarize a conversation
const summary = await memory.invoke('memory-summarize', {
  conversationId: 'session-42',
});

// Forget with cascade cleanup
await memory.invoke('memory-forget', {
  rid: '#12:0',
  confirm: true,
  cascade: true,
});
```

### Use as a remote ability (via broker)

```typescript
const client = new KadiClient({
  name: 'my-agent',
  version: '1.0.0',
  brokers: { default: { url: 'wss://broker.kadi.build/kadi' } },
});
await client.connect();

// agent-memory-ability must be running on the same broker
const result = await client.invokeRemote('memory-store', {
  content: 'Remember this from the broker!',
  agent: 'assistant-v1',
});
```

### Run standalone (CLI)

```bash
# Broker mode — connect to broker and serve tools
kadi run start

# Or directly
node dist/index.js broker

# STDIO mode
node dist/index.js stdio
```

## Tools

### `memory-store`

Store a memory with automatic entity extraction, embedding, and graph linking. Enforces `vertexType=Memory`, auto-adds agent and timestamp, creates Conversation vertex and `InConversation` edge when `conversationId` is provided.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `content` | `string` | **yes** | Memory content to store |
| `agent` | `string` | no | Agent identifier (default: from config) |
| `topics` | `string[]` | no | Explicit topics (skips extraction) |
| `entities` | `{name, type}[]` | no | Explicit entities (skips extraction) |
| `conversationId` | `string` | no | Conversation session ID |
| `importance` | `number` | no | Importance score 0–1 |
| `metadata` | `Record<string, unknown>` | no | Arbitrary metadata (JSON-stringified) |
| `skipExtraction` | `boolean` | no | Skip LLM extraction entirely |

**Returns:** `{ stored, rid, agent, conversationId?, topics, entities, importance, embeddingDimensions, durationMs }`

**Pipeline:** validate → build graph-store params → delegate to `graph-store` → upsert Conversation → create InConversation edge.

---

### `memory-recall`

Search stored memories with automatic agent isolation. Default mode is hybrid (semantic + keyword + graph with RRF fusion and importance weighting).

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `query` | `string` | **yes** | Search query |
| `agent` | `string` | no | Agent identifier (default: from config) |
| `limit` | `number` | no | Max results (default: 10) |
| `mode` | `'semantic' \| 'keyword' \| 'graph' \| 'hybrid'` | no | Search mode (default: `hybrid`) |
| `signals` | `string[]` | no | Signals for hybrid (default: `['semantic','keyword','graph']`) |
| `topics` | `string[]` | no | Topic filter for graph signal |
| `conversationId` | `string` | no | Filter to a specific conversation |

**Returns:** `{ results: SignalResult[], count, agent, mode, signals }`

> **Note:** The `structural` signal is intentionally excluded from defaults — memories use topic/entity edges, not direct structural links.

---

### `memory-context`

Retrieve rich graph context around a topic, entity, or memory. Supports four modes:

- **Query mode** — recall + graph expansion (delegates to `graph-context`)
- **RID mode** — start from a specific memory RID
- **Topic mode** — traverse from a named Topic vertex
- **Entity mode** — traverse from a named Entity vertex

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `query` | `string` | no | Search query for recall-based context |
| `topic` | `string` | no | Topic name to start from |
| `entity` | `string` | no | Entity name to start from |
| `entityType` | `string` | no | Entity type filter |
| `memoryRid` | `string` | no | Memory RID to start from |
| `agent` | `string` | no | Agent filter |
| `depth` | `number` | no | Traversal depth 1–4 (default: 2) |
| `limit` | `number` | no | Max results to expand (default: 5) |

**Returns (query):** `{ results: [...{ neighbors, edges }], count, depth, agent }`
**Returns (RID/topic/entity):** `{ found, startRid, depth, vertices, edges, vertexCount, edgeCount, agent }`

---

### `memory-relate`

Create a typed, weighted `RelatedTo` edge between any two vertices.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `fromRid` | `string` | **yes** | Source vertex RID |
| `toRid` | `string` | **yes** | Target vertex RID |
| `relationship` | `string` | no | Relationship type (default: `"related"`) |
| `weight` | `number` | no | Edge weight 0–1 (default: 0.5) |
| `bidirectional` | `boolean` | no | Create reverse edge too (default: false) |

**Returns:** `{ created, from, to, relationship, weight, bidirectional }`

---

### `memory-forget`

Delete memories with a safety guard. Requires `confirm: true`. Supports single-RID deletion, bulk deletion by agent/conversation/date, and optional cascade cleanup of orphaned Topics and Entities.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `rid` | `string` | no | Specific Memory RID to delete |
| `agent` | `string` | no | Delete all memories for this agent |
| `conversationId` | `string` | no | Delete memories in this conversation |
| `olderThan` | `string` | no | Delete memories older than this ISO date |
| `confirm` | `boolean` | **yes** | Must be `true` to proceed |
| `cascade` | `boolean` | no | Remove orphaned Topics/Entities (default: false) |

**Returns:** `{ deleted, memoriesRemoved, orphansRemoved }`

> At least one filter (`rid`, `agent`, `conversationId`, or `olderThan`) is required.

---

### `memory-conversations`

List conversation sessions sorted by most recent.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `agent` | `string` | no | Agent identifier (default: from config) |
| `since` | `string` | no | Only conversations after this ISO date |
| `limit` | `number` | no | Max results (default: 20, clamped 1–100) |

**Returns:** `{ conversations: [...{ conversationId, startTime, endTime, duration?, memoryCount, summary? }], count, agent }`

---

### `memory-summarize`

Generate a 2–4 sentence summary of all memories in a conversation via LLM. Stores the summary on the Conversation vertex for future retrieval.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `conversationId` | `string` | **yes** | Conversation ID to summarize |

**Returns:** `{ summarized, conversationId, memoryCount, summary }`

## Architecture

```
┌─────────────────────────┐
│  agent-memory-ability    │
│  7 memory-* tools        │
│  Schema enforcement      │
│  Agent isolation         │
│  Conversation tracking   │
└────────────┬────────────┘
             │ graphAbility.invoke()
┌────────────▼────────────┐
│  graph-ability           │
│  15 graph-* tools        │
│  N-signal hybrid search  │
│  Schema registry         │
│  Batch pipeline          │
│  SQL/chat passthrough    │
└────────────┬────────────┘
             │ invokeRemote (graph-ability's
             │ own broker connection)
┌────────────▼────────────┐     ┌──────────────────┐
│  arcadedb-ability        │     │  model-manager     │
│  ArcadeDB SQL bridge     │     │  create-embedding  │
│                          │     │  chat-completion   │
└──────────────────────────┘     └──────────────────┘
```

> **Key design:** agent-memory-ability never connects to a broker itself. All 7 tools route through `graphAbility.invoke()` (the loaded native instance of graph-ability), which in turn calls arcadedb-ability and model-manager via its own broker connection. This means agent-memory-ability has **zero direct broker traffic** when loaded natively.

### Deployment Modes

| Mode | How it works | Use case |
|------|-------------|----------|
| **Native** | `client.loadNative('agent-memory-ability')` imports the module in-process. Top-level `await` ensures vault credentials and all tools are ready before the import resolves. All calls route through graph-ability's native instance — no broker connection opened. | Agents that want zero-latency memory access |
| **Remote** | `client.invokeRemote('memory-store', ...)` routes through the KĀDI broker to a running instance. | Distributed agents on the same broker |
| **CLI** | `kadi run start` connects to broker and serves all 7 tools. | Standalone deployment (Docker, Akash) |

## Graph Schema

agent-memory-ability registers the `agent-memory` schema on startup:

### Vertex Types

**Memory** — individual agent memories

| Property | Type | Index |
|----------|------|-------|
| `content` | STRING | FULL_TEXT |
| `agent` | STRING | NOTUNIQUE |
| `timestamp` | DATETIME | NOTUNIQUE |
| `importance` | DOUBLE | — |
| `embedding` | EMBEDDEDLIST | — |
| `conversationId` | STRING | — |
| `metadata` | STRING | — |

**Conversation** — conversation sessions

| Property | Type | Index |
|----------|------|-------|
| `conversationId` | STRING | UNIQUE |
| `agent` | STRING | NOTUNIQUE |
| `startTime` | DATETIME | — |
| `endTime` | DATETIME | — |
| `summary` | STRING | — |
| `memoryCount` | INTEGER | — |

**Topic** / **Entity** — inherited from graph-ability (see [graph-ability README](../graph-ability/README.md))

### Edge Types

| Edge | Properties | Purpose |
|------|-----------|---------|
| `HasTopic` | `weight` | Memory → Topic |
| `Mentions` | `context` | Memory → Entity |
| `RelatedTo` | `type, weight, createdAt` | Any → Any |
| `InConversation` | — | Memory → Conversation |
| `REMEMBERED_DURING` | `timestamp` | Memory → Conversation |

## Configuration

Settings are resolved in order (highest priority wins):

1. **Environment variables** — `MEMORY_DATABASE`, `MEMORY_API_KEY`, etc.
2. **Vault `"models"`** — `MEMORY_API_KEY`, `MEMORY_API_URL` via `secret-ability`
3. **`config.yml`** — walk-up discovery from CWD (`memory:` section)
4. **Built-in defaults**

> **Example config** — see [`config.sample.yml`](config.sample.yml) in this repo for a fully-commented reference. Copy or merge the `memory:` section into your project's `config.yml`.

### Config Fields

| Field | Env Var | config.yml | Default |
|-------|---------|------------|---------|
| `database` | `MEMORY_DATABASE` | `memory.database` | `kadi_memory` |
| `embeddingModel` | `MEMORY_EMBEDDING_MODEL` | `memory.embedding_model` | `text-embedding-3-small` |
| `extractionModel` | `MEMORY_EXTRACTION_MODEL` | `memory.extraction_model` | `gpt-5-nano` |
| `summarizationModel` | `MEMORY_SUMMARIZATION_MODEL` | `memory.summarization_model` | `gpt-5-mini` |
| `chatModel` | `MEMORY_CHAT_MODEL` | `memory.chat_model` | `gpt-5-mini` |
| `defaultAgent` | `MEMORY_DEFAULT_AGENT` | `memory.default_agent` | `default` |
| `apiKey` | `MEMORY_API_KEY` | *(vault only)* | — |
| `apiUrl` | `MEMORY_API_URL` | *(vault only)* | — |
| `embeddingTransport` | `MEMORY_EMBEDDING_TRANSPORT` | `memory.embedding_transport` | `api` |
| `chatTransport` | `MEMORY_CHAT_TRANSPORT` | `memory.chat_transport` | `api` |

### Setting up the vault

```bash
kadi secret set --vault models --key MEMORY_API_KEY --value "sk-..."
kadi secret set --vault models --key MEMORY_API_URL --value "https://api.openai.com"
```

## Deployment

### agent.json

```json
{
  "name": "agent-memory-ability",
  "version": "0.0.7",
  "type": "ability",
  "entrypoint": "dist/index.js",
  "abilities": {
    "graph-ability": "^0.0.5",
    "secret-ability": "^0.9.0"
  },
  "brokers": {
    "default": "wss://broker.kadi.build/kadi"
  }
}
```

### Docker build & deploy

```bash
# Build the container
kadi build

# Deploy locally
kadi deploy local

# Deploy to Akash
kadi deploy akash
```

The container receives vault secrets at startup via `kadi secret receive --vault models` before running `kadi run start`.

### Infrastructure Requirements

| Service | Purpose | Required |
|---------|---------|----------|
| KĀDI Broker | Tool routing | yes |
| `arcadedb-ability` | ArcadeDB SQL bridge (`arcade-command`, `arcade-query`) | yes |
| `model-manager` | Embeddings + LLM (`create-embedding`, `chat-completion`) | yes |
| ArcadeDB | Graph database | yes |
| `secret-ability` | Vault credential management | yes (for vault mode) |
| `graph-ability` | Loaded natively or available on broker | yes |

## Testing

```bash
# Run all tests
npm test

# Unit tests only (no infra required)
npm run test:unit

# Integration tests (requires full infra)
npm run test:integration
```

### Test Suite

| Suite | Tests | Description |
|-------|-------|-------------|
| `store-wrapper.test.ts` | 15 | Schema enforcement, auto-agent, auto-timestamp, conversation edges, metadata, embedding config |
| `recall-wrapper.test.ts` | 16 | Schema enforcement, agent isolation, 3-signal default, custom signals, mode, limit, filters |
| `forget-cascade.test.ts` | 13 | Safety guard, filter validation, single/bulk delete, cascade orphan cleanup |
| `conversations.test.ts` | 14 | Agent filter, date filter, limit clamping, duration calculation, query patterns |
| **Unit total** | **58** | |
| `lifecycle.test.ts` | 5 | Store → recall → context → summarize → forget (full pipeline) |
| `full-lifecycle.test.ts` | 8 | Store×2 → recall → relate → verify → forget×2 → confirm deletion |
| `agent-isolation.test.ts` | 6 | Agent-A/B storage and retrieval isolation |
| **Integration total** | **19** | |

### Integration Test Architecture

Tests load graph-ability in-process (native) and patch `invokeRemote` for local tool routing:

```
memory-* tools (test client)
    → graph-* tools (graph-ability, in-process)
        → arcade-command / arcade-query (broker)
        → create-embedding / chat-completion (broker)
```

This avoids needing graph-ability on the broker during tests while still exercising the full tool chain.

## Development

```bash
# Install dependencies
npm install

# Install KĀDI abilities (graph-ability, secret-ability)
kadi install

# Build
npm run build

# Dev mode (tsx, no compile step)
npm run dev
```

### Project Structure

```
agent-memory-ability/
├── agent.json              # KĀDI ability manifest
├── config.sample.yml       # Example config.yml (copy/merge into your project)
├── package.json
├── tsconfig.json
├── vitest.config.ts
├── src/
│   ├── index.ts            # Entry point — top-level await init + exports
│   ├── lib/
│   │   └── config.ts       # Config resolution (env → vault → yml → defaults)
│   └── tools/
│       ├── store.ts        # memory-store
│       ├── recall.ts       # memory-recall
│       ├── context.ts      # memory-context
│       ├── relate.ts       # memory-relate
│       ├── forget.ts       # memory-forget
│       ├── conversations.ts # memory-conversations
│       └── summarize.ts    # memory-summarize
├── tests/
│   ├── unit/
│   │   ├── store-wrapper.test.ts
│   │   ├── recall-wrapper.test.ts
│   │   ├── forget-cascade.test.ts
│   │   └── conversations.test.ts
│   └── integration/
│       ├── helpers.ts      # Test context, invokeRemote patching, cleanup
│       ├── lifecycle.test.ts
│       ├── full-lifecycle.test.ts
│       └── agent-isolation.test.ts
└── abilities/              # Installed KĀDI abilities (kadi install)
    ├── graph-ability@0.0.5/
    └── secret-ability@0.9.1/
```

## Exports

When used as a native library:

| Export | Type | Description |
|--------|------|-------------|
| `default` | `KadiClient` | Pre-configured client with all 7 tools registered |
| `MEMORY_SCHEMA` | `SchemaDefinition` | Full graph schema definition |
| `MEMORY_VERTEX` | `VertexTypeDef` | Memory vertex type definition |
| `CONVERSATION_VERTEX` | `VertexTypeDef` | Conversation vertex type definition |
| `loadMemoryConfig()` | `() => MemoryConfig` | Sync config (no vault) |
| `loadMemoryConfigWithVault(client)` | `(client) => Promise<MemoryConfig>` | Async config with vault |
| `MemoryConfig` | type | Configuration interface |

## License

Proprietary — [HuMIn Game Lab](https://humingamelab.com)
