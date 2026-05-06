/**
 * memory-recall tool — Search stored memories using N-signal hybrid recall.
 *
 * Thin wrapper over graph-recall: enforces vertexType='Memory', adds agent
 * filter, uses 3-signal default (semantic, keyword, graph — no structural).
 */

import { KadiClient, z } from '@kadi.build/core';

import type { MemoryConfig } from '../lib/config.js';
import type { SignalAbilities } from '../lib/graph-types.js';
import { resolveAgentFilter } from '../lib/agent-filter.js';
import { reflectOnFragments } from '../lib/reflect.js';

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
        'and importance weighting). Agent isolation is enforced automatically. ' +
        'Pass agent: "*" for cross-agent recall, or agent: ["a", "b"] for multi-agent. ' +
        'Pass reflect: true to synthesize fragments into a coherent summary via LLM.',
      input: z.object({
        query: z.string().describe('Search query text'),
        agent: z.union([z.string(), z.array(z.string())]).optional()
          .describe('Agent filter: string, array of strings, or "*" for all agents (default: from config)'),
        limit: z.number().optional().describe('Max results (default: 10)'),
        mode: z.enum(['semantic', 'keyword', 'graph', 'hybrid']).optional()
          .describe('Search mode (default: hybrid)'),
        signals: z.array(z.string()).optional()
          .describe('Signals for hybrid mode (default: semantic, keyword, graph)'),
        topics: z.array(z.string()).optional()
          .describe('Optional topic filter for graph mode'),
        conversationId: z.string().optional()
          .describe('Filter to a specific conversation'),
        reflect: z.boolean().optional()
          .describe('Synthesize fragments into coherent summary via LLM (default: false)'),
      }),
    },
    async (input) => {
      try {
        const { agentFilter, agentDisplay } = resolveAgentFilter(input.agent, config.defaultAgent);
        const limit = input.limit ?? 10;
        const mode = input.mode ?? 'hybrid';

        // Build filters — spread agent filter (may be empty for wildcard)
        const filters: Record<string, unknown> = {
          ...agentFilter,
          valid: true,
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

        // Access tracking — fire-and-forget update of access_count and last_accessed
        const results = Array.isArray((result as any).results) ? (result as any).results : [];
        if (results.length > 0) {
          const now = new Date().toISOString();
          const rids = results
            .map((r: any) => r.rid ?? r.id)
            .filter((rid: string) => rid?.startsWith('#'));
          if (rids.length > 0) {
            abilities.invoke('graph-command', {
              database: config.database,
              command: `UPDATE Memory SET access_count = ifnull(access_count, 0) + 1, last_accessed = '${now}' WHERE @rid IN [${rids.join(',')}]`,
            }).catch(() => {});
          }
        }

        // Reflect synthesis — produce coherent summary from fragments
        let reflect: Record<string, unknown> | undefined;
        if (input.reflect) {
          const fragments = Array.isArray((result as any).results)
            ? (result as any).results
            : [];
          const synthesis = await reflectOnFragments(abilities, config, input.query, fragments);
          if (synthesis) {
            reflect = synthesis as unknown as Record<string, unknown>;
          }
        }

        return {
          ...result,
          agent: agentDisplay,
          mode,
          ...(reflect ? { reflect } : {}),
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
