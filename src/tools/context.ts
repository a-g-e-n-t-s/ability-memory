/**
 * memory-context tool — Graph traversal context around a memory, topic, or entity.
 *
 * Thin wrapper over graph-context: delegates with Memory scope.
 */

import { KadiClient, z } from '@kadi.build/core';

import type { MemoryConfig } from '../lib/config.js';
import type { SignalAbilities } from '../lib/graph-types.js';

export function registerContextTool(
  client: KadiClient,
  config: MemoryConfig,
  abilities: SignalAbilities,
): void {

  client.registerTool(
    {
      name: 'memory-context',
      description:
        'Retrieve a graph context around a topic, entity, or memory. ' +
        'Performs recall then expands via graph traversal for richer context.',
      input: z.object({
        query: z.string().optional().describe('Search query for recall-based context'),
        topic: z.string().optional().describe('Topic name to start from'),
        entity: z.string().optional().describe('Entity name to start from'),
        entityType: z.string().optional().describe('Entity type filter'),
        memoryRid: z.string().optional().describe('Memory RID to start from (e.g., "#12:0")'),
        agent: z.string().optional().describe('Agent filter for Memory vertices'),
        depth: z.number().optional().describe('Traversal depth (1-4, default: 2)'),
        limit: z.number().optional().describe('Max recalled results to expand (default: 5)'),
      }),
    },
    async (input) => {
      try {
        const agent = input.agent ?? config.defaultAgent;
        const depth = Math.max(1, Math.min(4, input.depth ?? 2));
        const limit = input.limit ?? 5;

        // If a query is provided, use graph-context for recall + traversal
        if (input.query) {
          const result = await abilities.invoke<Record<string, unknown>>('graph-context', {
            query: input.query,
            vertexType: 'Memory',
            depth,
            limit,
            filters: { agent },
            signals: ['semantic', 'keyword', 'graph'],
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
          };
        }

        // Otherwise, resolve starting vertex and do direct traversal
        // For topic/entity/memoryRid, query ArcadeDB directly
        let startRid: string | null = input.memoryRid ?? null;

        if (!startRid && input.topic) {
          startRid = await findVertexRid(abilities, config.database, 'Topic', 'name', input.topic);
        }

        if (!startRid && input.entity) {
          const conditions = input.entityType
            ? `name = '${escapeSimple(input.entity)}' AND type = '${escapeSimple(input.entityType)}'`
            : `name = '${escapeSimple(input.entity)}'`;
          startRid = await findVertexRidByCondition(abilities, config.database, 'Entity', conditions);
        }

        if (!startRid) {
          return {
            found: false,
            error: '[memory-context] No starting vertex found. Provide a query, topic, entity, or memoryRid.',
            tool: 'memory-context',
          };
        }

        // Use graph-context with a dummy query to get traversal
        // (the context tool will expand from recalled results)
        // For direct RID, we do a manual traversal via graph-query
        const traversalResult = await abilities.invoke<{
          success: boolean;
          result?: Array<Record<string, unknown>>;
        }>('graph-query', {
          database: config.database,
          query: `MATCH {class: V, as: start, where: (@rid = ${startRid})}` +
            `.bothE() {as: edge}` +
            `.bothV() {as: neighbor, where: ($depth <= ${depth})}` +
            ` RETURN start, edge, neighbor`,
        });

        const vertices: Array<Record<string, unknown>> = [];
        const edges: Array<Record<string, unknown>> = [];
        const seenRids = new Set<string>();

        if (traversalResult.success && traversalResult.result) {
          for (const row of traversalResult.result) {
            const start = row.start as Record<string, unknown> | undefined;
            const neighbor = row.neighbor as Record<string, unknown> | undefined;
            const edge = row.edge as Record<string, unknown> | undefined;

            if (start) {
              const rid = (start['@rid'] as string) ?? '';
              if (rid && !seenRids.has(rid)) {
                seenRids.add(rid);
                vertices.push(start);
              }
            }
            if (neighbor) {
              const rid = (neighbor['@rid'] as string) ?? '';
              if (rid && !seenRids.has(rid)) {
                seenRids.add(rid);
                vertices.push(neighbor);
              }
            }
            if (edge) {
              edges.push(edge);
            }
          }
        }

        return {
          found: true,
          startRid,
          depth,
          vertices,
          edges,
          vertexCount: vertices.length,
          edgeCount: edges.length,
          agent,
        };
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          found: false,
          error: `[memory-context] ${message}`,
          tool: 'memory-context',
        };
      }
    },
  );
}

async function findVertexRid(
  abilities: SignalAbilities,
  database: string,
  vertexType: string,
  field: string,
  value: string,
): Promise<string | null> {
  const result = await abilities.invoke<{
    success: boolean;
    result?: Array<Record<string, unknown>>;
  }>('graph-query', {
    database,
    query: `SELECT @rid FROM ${vertexType} WHERE ${field} = '${escapeSimple(value)}'`,
  });

  if (result.success && result.result && result.result.length > 0) {
    return (result.result[0]['@rid'] as string) ?? null;
  }
  return null;
}

async function findVertexRidByCondition(
  abilities: SignalAbilities,
  database: string,
  vertexType: string,
  conditions: string,
): Promise<string | null> {
  const result = await abilities.invoke<{
    success: boolean;
    result?: Array<Record<string, unknown>>;
  }>('graph-query', {
    database,
    query: `SELECT @rid FROM ${vertexType} WHERE ${conditions}`,
  });

  if (result.success && result.result && result.result.length > 0) {
    return (result.result[0]['@rid'] as string) ?? null;
  }
  return null;
}

function escapeSimple(str: string): string {
  return str.replace(/'/g, "\\'");
}
