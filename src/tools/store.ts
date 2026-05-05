/**
 * memory-store tool — Store a memory with automatic fact extraction, reconciliation,
 * entity extraction, embedding, and graph linking.
 *
 * Write path (when reconciliation enabled):
 *   1. extractFacts() — decompose input into atomic facts
 *   2. reconcileFacts() — compare against existing memories → ADD/UPDATE/DELETE/NONE
 *   3. Execute actions: ADD → graph-store, UPDATE → graph-command, DELETE → soft-delete, NONE → bump mentions
 *
 * When skipReconciliation=true or skipExtraction=true, falls back to direct graph-store (legacy path).
 */

import { KadiClient, z } from '@kadi.build/core';

import type { MemoryConfig } from '../lib/config.js';
import type { SignalAbilities } from '../lib/graph-types.js';
import { extractFacts, reconcileFacts } from '../lib/reconciliation.js';
import type { ReconciliationEntry } from '../lib/reconciliation.js';

export function registerStoreTool(
  client: KadiClient,
  config: MemoryConfig,
  abilities: SignalAbilities,
): void {

  client.registerTool(
    {
      name: 'memory-store',
      description:
        'Store a memory with automatic fact extraction, reconciliation, embedding, and graph linking. ' +
        'Extracts atomic facts, deduplicates against existing memories, and only stores new/updated information.',
      input: z.object({
        content: z.string().describe('The memory content to store'),
        agent: z.string().optional().describe('Agent identifier (default: from config)'),
        topics: z.array(z.string()).optional().describe('Explicit topics (skips extraction for topics)'),
        entities: z.array(z.object({
          name: z.string(),
          type: z.string(),
        })).optional().describe('Explicit entities (skips extraction for entities)'),
        conversationId: z.string().optional().describe('Conversation session ID'),
        importance: z.number().optional().describe('Importance score 0-1 (extracted if not provided)'),
        metadata: z.record(z.string(), z.unknown()).optional().describe('Arbitrary metadata'),
        skipExtraction: z.boolean().optional().describe('Skip LLM extraction entirely (legacy direct store)'),
        skipReconciliation: z.boolean().optional().describe('Skip reconciliation (store all facts as new)'),
      }),
    },
    async (input) => {
      const startTime = Date.now();
      try {
        const agent = input.agent ?? config.defaultAgent;
        const now = new Date().toISOString();

        // Legacy path: skip reconciliation entirely
        if (input.skipExtraction || input.skipReconciliation) {
          const result = await directStore(abilities, config, input, agent, now);
          return {
            ...result,
            agent,
            reconciliation: null,
            conversationId: input.conversationId,
            durationMs: Date.now() - startTime,
          };
        }

        // Step 1: Extract facts from input
        const facts = await extractFacts(input.content, abilities, config);

        if (facts.length === 0) {
          // No meaningful facts — store as-is (might be a greeting or noise)
          return {
            stored: false,
            reason: 'no_facts_extracted',
            agent,
            durationMs: Date.now() - startTime,
          };
        }

        // Step 2: Reconcile against existing memories
        const reconciliation = await reconcileFacts(facts, abilities, config, agent);

        // Step 3: Execute actions
        const results = await executeReconciliationActions(
          reconciliation.entries, abilities, config, agent, now, input,
        );

        // Step 4: Upsert conversation if provided
        if (input.conversationId) {
          try {
            await ensureConversation(abilities, config.database, input.conversationId, agent, now);
          } catch (err) {
            console.warn('[memory-store] Failed to upsert conversation:', err);
          }
        }

        return {
          stored: true,
          agent,
          conversationId: input.conversationId,
          reconciliation: {
            factsExtracted: facts.length,
            added: results.filter(r => r.action === 'ADD').length,
            updated: results.filter(r => r.action === 'UPDATE').length,
            deleted: results.filter(r => r.action === 'DELETE').length,
            skipped: results.filter(r => r.action === 'NONE').length,
            durationMs: reconciliation.durationMs,
          },
          actions: results,
          durationMs: Date.now() - startTime,
        };
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          stored: false,
          error: `[memory-store] ${message}`,
          tool: 'memory-store',
          durationMs: Date.now() - startTime,
        };
      }
    },
  );
}

// ── Direct store (legacy path) ────────────────────────────────────────

async function directStore(
  abilities: SignalAbilities,
  config: MemoryConfig,
  input: Record<string, unknown>,
  agent: string,
  now: string,
): Promise<Record<string, unknown>> {
  const properties: Record<string, unknown> = {
    agent,
    timestamp: now,
    mentions: 1,
    valid: true,
  };

  if (input.conversationId) properties.conversationId = input.conversationId;
  if (input.metadata) properties.metadata = input.metadata;

  const edges: Array<Record<string, unknown>> = [];
  if (input.conversationId) {
    edges.push({
      type: 'InConversation',
      direction: 'out',
      targetQuery: {
        vertexType: 'Conversation',
        where: { conversationId: input.conversationId },
      },
    });
  }

  const result = await abilities.invoke<Record<string, unknown>>('graph-store', {
    content: input.content,
    vertexType: 'Memory',
    properties,
    topics: input.topics,
    entities: input.entities,
    edges: edges.length > 0 ? edges : undefined,
    database: config.database,
    skipExtraction: input.skipExtraction,
    importance: input.importance,
    embedding: {
      model: config.embeddingModel,
      transport: config.embeddingTransport,
      apiUrl: config.apiUrl,
      apiKey: config.apiKey,
    },
  });

  if (input.conversationId) {
    try {
      await ensureConversation(abilities, config.database, input.conversationId as string, agent, now);
    } catch (err) {
      console.warn('[memory-store] Failed to upsert conversation:', err);
    }
  }

  return result;
}

// ── Execute reconciliation actions ────────────────────────────────────

interface ActionResult {
  action: string;
  factText: string;
  targetId?: string;
  success: boolean;
  error?: string;
}

async function executeReconciliationActions(
  entries: ReconciliationEntry[],
  abilities: SignalAbilities,
  config: MemoryConfig,
  agent: string,
  now: string,
  input: Record<string, unknown>,
): Promise<ActionResult[]> {
  const results: ActionResult[] = [];

  for (const entry of entries) {
    try {
      switch (entry.action) {
        case 'ADD': {
          const storeResult = await abilities.invoke<Record<string, unknown>>('graph-store', {
            content: entry.fact.text,
            vertexType: 'Memory',
            properties: {
              agent,
              timestamp: now,
              mentions: 1,
              valid: true,
              ...(input.conversationId ? { conversationId: input.conversationId } : {}),
              ...(input.metadata ? { metadata: input.metadata } : {}),
            },
            topics: entry.fact.topics.length > 0 ? entry.fact.topics : undefined,
            entities: entry.fact.entities.length > 0 ? entry.fact.entities : undefined,
            database: config.database,
            importance: input.importance,
            embedding: {
              model: config.embeddingModel,
              transport: config.embeddingTransport,
              apiUrl: config.apiUrl,
              apiKey: config.apiKey,
            },
          });
          console.log('[memory-store] graph-store result:', JSON.stringify(storeResult).slice(0, 300));
          const success = storeResult?.stored === true;
          results.push({ action: 'ADD', factText: entry.fact.text, success, error: success ? undefined : String(storeResult?.error ?? 'unknown') });
          break;
        }

        case 'UPDATE': {
          if (!entry.targetId) {
            // No target — treat as ADD
            await abilities.invoke('graph-store', {
              content: entry.mergedText ?? entry.fact.text,
              vertexType: 'Memory',
              properties: { agent, timestamp: now, mentions: 1, valid: true },
              topics: entry.fact.topics.length > 0 ? entry.fact.topics : undefined,
              entities: entry.fact.entities.length > 0 ? entry.fact.entities : undefined,
              database: config.database,
              embedding: {
                model: config.embeddingModel,
                transport: config.embeddingTransport,
                apiUrl: config.apiUrl,
                apiKey: config.apiKey,
              },
            });
            results.push({ action: 'ADD', factText: entry.mergedText ?? entry.fact.text, success: true });
            break;
          }

          const newContent = entry.mergedText ?? entry.fact.text;
          await abilities.invoke('graph-command', {
            database: config.database,
            command:
              `UPDATE ${entry.targetId} SET` +
              ` content = '${escapeSimple(newContent)}',` +
              ` timestamp = '${now}',` +
              ` mentions = mentions + 1`,
          });
          results.push({ action: 'UPDATE', factText: newContent, targetId: entry.targetId, success: true });
          break;
        }

        case 'DELETE': {
          if (!entry.targetId) {
            results.push({ action: 'DELETE', factText: entry.fact.text, success: false, error: 'no target ID' });
            break;
          }
          // Soft-delete: set valid=false
          await abilities.invoke('graph-command', {
            database: config.database,
            command:
              `UPDATE ${entry.targetId} SET valid = false, invalidatedAt = '${now}'`,
          });
          results.push({ action: 'DELETE', factText: entry.fact.text, targetId: entry.targetId, success: true });
          break;
        }

        case 'NONE': {
          // Fact already exists — bump mentions counter
          if (entry.targetId) {
            await abilities.invoke('graph-command', {
              database: config.database,
              command: `UPDATE ${entry.targetId} SET mentions = mentions + 1`,
            });
          }
          results.push({ action: 'NONE', factText: entry.fact.text, targetId: entry.targetId, success: true });
          break;
        }
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      results.push({ action: entry.action, factText: entry.fact.text, success: false, error: message });
    }
  }

  return results;
}

// ── Conversation management ───────────────────────────────────────────

async function ensureConversation(
  abilities: SignalAbilities,
  database: string,
  conversationId: string,
  agent: string,
  timestamp: string,
): Promise<void> {
  const queryResult = await abilities.invoke<{
    success: boolean;
    result?: Array<Record<string, unknown>>;
  }>('graph-query', {
    database,
    query: `SELECT @rid, memoryCount FROM Conversation WHERE conversationId = '${escapeSimple(conversationId)}'`,
  });

  if (queryResult.success && queryResult.result && queryResult.result.length > 0) {
    const currentCount = (queryResult.result[0].memoryCount as number) ?? 0;
    await abilities.invoke('graph-command', {
      database,
      command:
        `UPDATE Conversation SET endTime = '${timestamp}', memoryCount = ${currentCount + 1}` +
        ` WHERE conversationId = '${escapeSimple(conversationId)}'`,
    });
  } else {
    await abilities.invoke('graph-command', {
      database,
      command:
        `CREATE VERTEX Conversation SET` +
        ` conversationId = '${escapeSimple(conversationId)}',` +
        ` agent = '${escapeSimple(agent)}',` +
        ` startTime = '${timestamp}',` +
        ` endTime = '${timestamp}',` +
        ` memoryCount = 1`,
    });
  }
}

/** Simple SQL string escape (single quotes). */
function escapeSimple(str: string): string {
  return str.replace(/'/g, "\\'");
}
