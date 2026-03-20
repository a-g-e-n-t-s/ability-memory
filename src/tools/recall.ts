/**
 * memory-recall tool — Search stored memories using N-signal hybrid recall.
 *
 * Thin wrapper over graph-recall: enforces vertexType='Memory', adds agent
 * filter, uses 3-signal default (semantic, keyword, graph — no structural).
 */

import { KadiClient, z } from '@kadi.build/core';

import type { MemoryConfig } from '../lib/config.js';
import type { SignalAbilities } from '../lib/graph-types.js';

export function registerRecallTool(
  client: KadiClient,
  config: MemoryConfig,
  abilities: SignalAbilities,
): void {

  client.registerTool(
    {
      name: 'memory-recall',
      description:
        'Search stored memories using semantic, keyword, graph, or hybrid mode. ' +
        'Default mode is hybrid (combines semantic + keyword + graph with RRF fusion ' +
        'and importance weighting). Agent isolation is enforced automatically.',
      input: z.object({
        query: z.string().describe('Search query text'),
        agent: z.string().optional().describe('Agent identifier (default: from config)'),
        limit: z.number().optional().describe('Max results (default: 10)'),
        mode: z.enum(['semantic', 'keyword', 'graph', 'hybrid']).optional()
          .describe('Search mode (default: hybrid)'),
        signals: z.array(z.string()).optional()
          .describe('Signals for hybrid mode (default: semantic, keyword, graph)'),
        topics: z.array(z.string()).optional()
          .describe('Optional topic filter for graph mode'),
        conversationId: z.string().optional()
          .describe('Filter to a specific conversation'),
      }),
    },
    async (input) => {
      try {
        const agent = input.agent ?? config.defaultAgent;
        const limit = input.limit ?? 10;
        const mode = input.mode ?? 'hybrid';

        // Build agent filter — enforces agent isolation
        const filters: Record<string, unknown> = {
          agent,
        };

        if (input.conversationId) {
          filters.conversationId = input.conversationId;
        }

        // Default 3-signal set: semantic, keyword, graph (NO structural)
        const signals = input.signals ?? ['semantic', 'keyword', 'graph'];

        // Delegate to graph-recall with enforced vertexType='Memory'
        const result = await abilities.invoke<Record<string, unknown>>('graph-recall', {
          query: input.query,
          vertexType: 'Memory',
          mode,
          signals,
          filters,
          limit,
          database: config.database,
          embedding: {
            model: config.embeddingModel,
            transport: config.embeddingTransport,
            apiUrl: config.apiUrl,
            apiKey: config.apiKey,
          },
        });

        return {
          ...result,
          agent,
          mode,
        };
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          success: false,
          error: `[memory-recall] ${message}`,
          tool: 'memory-recall',
          hint: 'This tool requires arcadedb-ability and model-manager on the broker.',
        };
      }
    },
  );
}
