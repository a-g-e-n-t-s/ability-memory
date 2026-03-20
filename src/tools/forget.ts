/**
 * memory-forget tool — Delete memories with optional cascade.
 *
 * Wraps graph-delete with domain-specific cascade logic: after deleting
 * a Memory vertex, queries for orphaned Topic/Entity vertices that have
 * no remaining edges and removes them.
 *
 * Requires `confirm: true` as a safety guard. Supports filtering by RID,
 * agent, conversationId, or olderThan.
 */

import { KadiClient, z } from '@kadi.build/core';

import type { MemoryConfig } from '../lib/config.js';
import type { SignalAbilities } from '../lib/graph-types.js';

export function registerForgetTool(
  client: KadiClient,
  config: MemoryConfig,
  abilities: SignalAbilities,
): void {

  client.registerTool(
    {
      name: 'memory-forget',
      description:
        'Delete memories matching given criteria. Requires confirm: true as a safety guard. ' +
        'Optional cascade removes orphaned Topics and Entities with no remaining connections.',
      input: z.object({
        rid: z.string().optional().describe('Specific Memory RID to delete'),
        agent: z.string().optional().describe('Delete all memories for this agent'),
        conversationId: z.string().optional().describe('Delete memories in this conversation'),
        olderThan: z.string().optional().describe('Delete memories older than this ISO date'),
        confirm: z.boolean().describe('Must be true to proceed with deletion'),
        cascade: z.boolean().optional().describe('Remove orphaned Topics/Entities (default: false)'),
      }),
    },
    async (input) => {
      try {
        if (!input.confirm) {
          return {
            deleted: false,
            error: '[memory-forget] Safety guard: set confirm: true to proceed with deletion.',
            tool: 'memory-forget',
          };
        }

        // At least one filter must be provided
        if (!input.rid && !input.agent && !input.conversationId && !input.olderThan) {
          return {
            deleted: false,
            error: '[memory-forget] At least one filter (rid, agent, conversationId, olderThan) must be provided.',
            tool: 'memory-forget',
          };
        }

        const database = config.database;
        let memoriesRemoved = 0;

        if (input.rid) {
          // Delete specific memory via graph-delete
          const deleteResult = await abilities.invoke<{ success: boolean; error?: string }>('graph-delete', {
            rid: input.rid,
            cascade: false, // We handle cascade ourselves for domain-specific orphan detection
            database,
          });

          if (deleteResult.success) {
            memoriesRemoved = 1;
          } else {
            console.error('[memory-forget] graph-delete failed:', deleteResult.error ?? JSON.stringify(deleteResult));
          }
        } else {
          // Build WHERE clause from filters
          const conditions: string[] = [];
          if (input.agent) {
            conditions.push(`agent = '${escapeSimple(input.agent)}'`);
          }
          if (input.conversationId) {
            conditions.push(`conversationId = '${escapeSimple(input.conversationId)}'`);
          }
          if (input.olderThan) {
            conditions.push(`timestamp < '${escapeSimple(input.olderThan)}'`);
          }

          // Get RIDs to delete
          const selectQuery = `SELECT @rid FROM Memory WHERE ${conditions.join(' AND ')}`;

          const selectResult = await abilities.invoke<{
            success: boolean;
            result?: Array<Record<string, unknown>>;
          }>('graph-query', {
            database,
            query: selectQuery,
          });

          if (selectResult.success && selectResult.result) {
            for (const row of selectResult.result) {
              const rid = (row['@rid'] as string) ?? '';
              if (rid) {
                try {
                  const delResult = await abilities.invoke<{ success: boolean; error?: string }>('graph-delete', {
                    rid,
                    cascade: false,
                    database,
                  });
                  if (delResult.success) {
                    memoriesRemoved++;
                  }
                } catch (err) {
                  console.warn(`[memory-forget] Failed to delete ${rid}:`, err);
                }
              }
            }
          }
        }

        // Domain-specific cascade: remove orphaned Topics/Entities
        let orphansRemoved = 0;
        if (input.cascade) {
          orphansRemoved = await removeOrphanedVertices(abilities, database);
        }

        return {
          deleted: true,
          memoriesRemoved,
          orphansRemoved,
        };
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        console.error('[memory-forget] CAUGHT ERROR:', message, err);
        return {
          deleted: false,
          error: `[memory-forget] ${message}`,
          tool: 'memory-forget',
        };
      }
    },
  );
}

/**
 * Domain-specific orphan detection and removal.
 *
 * Finds Topic and Entity vertices that have no remaining edges
 * (both in and out) and deletes them.
 */
async function removeOrphanedVertices(
  abilities: SignalAbilities,
  database: string,
): Promise<number> {
  let removed = 0;

  // Find orphaned Topics (no edges)
  const orphanTopics = await abilities.invoke<{
    success: boolean;
    result?: Array<Record<string, unknown>>;
  }>('graph-query', {
    database,
    query: `SELECT @rid FROM Topic WHERE bothE().size() = 0`,
  });

  if (orphanTopics.success && orphanTopics.result) {
    for (const row of orphanTopics.result) {
      const rid = (row['@rid'] as string) ?? '';
      if (rid) {
        try {
          await abilities.invoke('graph-delete', { rid, database });
          removed++;
        } catch {
          // Continue on failure
        }
      }
    }
  }

  // Find orphaned Entities (no edges)
  const orphanEntities = await abilities.invoke<{
    success: boolean;
    result?: Array<Record<string, unknown>>;
  }>('graph-query', {
    database,
    query: `SELECT @rid FROM Entity WHERE bothE().size() = 0`,
  });

  if (orphanEntities.success && orphanEntities.result) {
    for (const row of orphanEntities.result) {
      const rid = (row['@rid'] as string) ?? '';
      if (rid) {
        try {
          await abilities.invoke('graph-delete', { rid, database });
          removed++;
        } catch {
          // Continue on failure
        }
      }
    }
  }

  return removed;
}

function escapeSimple(str: string): string {
  return str.replace(/'/g, "\\'");
}
