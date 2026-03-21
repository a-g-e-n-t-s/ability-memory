/**
 * memory-store tool — Store a memory with automatic entity extraction, embedding,
 * and graph linking.
 *
 * Thin wrapper over graph-store: enforces vertexType='Memory', auto-adds agent
 * and timestamp, delegates all graph operations to graph-ability.
 */

import { KadiClient, z } from '@kadi.build/core';

import type { MemoryConfig } from '../lib/config.js';
import type { SignalAbilities } from '../lib/graph-types.js';

export function registerStoreTool(
  client: KadiClient,
  config: MemoryConfig,
  abilities: SignalAbilities,
): void {

  client.registerTool(
    {
      name: 'memory-store',
      description:
        'Store a memory with automatic entity extraction, embedding, and graph linking. ' +
        'Extracts topics and entities via LLM, embeds content for semantic search, ' +
        'and creates graph edges to Topics, Entities, and Conversations.',
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
        skipExtraction: z.boolean().optional().describe('Skip LLM extraction entirely'),
      }),
    },
    async (input) => {
      const startTime = Date.now();
      try {
        const agent = input.agent ?? config.defaultAgent;
        const now = new Date().toISOString();

        // Build properties with enforced Memory defaults
        const properties: Record<string, unknown> = {
          agent,
          timestamp: now,
        };

        if (input.conversationId) {
          properties.conversationId = input.conversationId;
        }

        if (input.metadata) {
          properties.metadata = input.metadata;
        }

        // Build edges for conversation if provided
        const edges: Array<{
          type: string;
          direction: 'out' | 'in';
          targetRid?: string;
          targetQuery?: { vertexType: string; where: Record<string, unknown> };
          properties?: Record<string, unknown>;
        }> = [];

        if (input.conversationId) {
          // Create InConversation edge to the Conversation vertex
          edges.push({
            type: 'InConversation',
            direction: 'out',
            targetQuery: {
              vertexType: 'Conversation',
              where: { conversationId: input.conversationId },
            },
          });
        }

        // Delegate to graph-store with enforced vertexType='Memory'
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

        // If conversation exists, upsert the Conversation vertex
        if (input.conversationId) {
          try {
            await ensureConversation(abilities, config.database, input.conversationId, agent, now);
          } catch (err) {
            console.warn('[memory-store] Failed to upsert conversation:', err);
          }
        }

        return {
          ...result,
          agent,
          conversationId: input.conversationId,
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

/**
 * Ensure a Conversation vertex exists (upsert). Updates endTime and increments
 * memoryCount on each call.
 */
async function ensureConversation(
  abilities: SignalAbilities,
  database: string,
  conversationId: string,
  agent: string,
  timestamp: string,
): Promise<void> {
  // Try to find existing conversation
  const queryResult = await abilities.invoke<{
    success: boolean;
    result?: Array<Record<string, unknown>>;
  }>('graph-query', {
    database,
    query: `SELECT @rid, memoryCount FROM Conversation WHERE conversationId = '${escapeSimple(conversationId)}'`,
  });

  if (queryResult.success && queryResult.result && queryResult.result.length > 0) {
    // Update existing conversation
    const currentCount = (queryResult.result[0].memoryCount as number) ?? 0;
    await abilities.invoke('graph-command', {
      database,
      command:
        `UPDATE Conversation SET endTime = '${timestamp}', memoryCount = ${currentCount + 1}` +
        ` WHERE conversationId = '${escapeSimple(conversationId)}'`,
    });
  } else {
    // Create new conversation
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
