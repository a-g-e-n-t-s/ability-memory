# ability-memory

Domain layer for conversational agent memory in the [KĀDI](https://kadi.build) framework. A thin, opinionated wrapper over [ability-graph](../ability-graph) providing 7 `memory-*` tools with enforced Memory schema defaults, automatic agent isolation, conversation tracking, cascade deletion, and LLM summarization.

## Features

- **7 memory-specific tools** — store, recall, context, relate, forget, conversations, summarize
- **Agent isolation** — every query is automatically scoped to the calling agent
- **Conversation sessions** — group memories by `conversationId`, track duration and count
- **LLM summarization** — generate 2–4 sentence conversation summaries via the configured chat model (configurable; default: `gpt-5-mini`)
- **Cascade delete** — forget a memory and automatically clean up orphaned Topics/Entities
- **Three deployment modes** — native library, remote broker ability, or standalone CLI
- **Vault-first credentials** — API keys loaded from the `models` vault via `secret-ability`; no `.env` files
- **Comprehensive test suite** — 58 unit tests + 19 integration tests

## Quick Start

### Install as a KĀDI ability

```bash
kadi install ability-memory
```

### Use as a native library (in-process)

```typescript
import { KadiClient } from '@kadi.build/core';

const client = new KadiClient({ name: 'my-agent', version: '1.0.0' });
const memory = await client.loadNative('ability-memory');

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
  brokers: { remote: { url: 'wss://broker.dadavidtseng.com/kadi' } },
});
await client.connect();

// ability-memory must be running on the same broker
const result = await client.invokeRemote('memory-store', {
  content: 'Remember this from the broker!',
  agent: 'assistant-v1',
});
```

### Run standalone (CLI)

```bash
# Broker mode — connect to broker and serve tools
kadi run start

# Or directly (container / local build)
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
| `entity` | `string` | no | Entity name

---

(Other tools — `memory-relate`, `memory-forget`, `memory-conversations`, `memory-summarize` — are registered as part of the ability and follow the patterns shown above; `memory-summarize` produces a concise 2–4 sentence summary of a conversation using the configured chat LLM.)