/**
 * memory-conversations tool — List conversation sessions.
 *
 * Domain-specific query that queries Conversation vertices and their
 * associated memory counts, sorted by most recent.
 */

import { KadiClient, z } from '@kadi.build/core';

import type { MemoryConfig } from '../lib/config.js';
import type { SignalAbilities } from '../lib/graph-types.js';

export function registerConversationsTool(
  client: KadiClient,
  config: MemoryConfig,
  abilities: SignalAbilities,
): void {

  client.registerTool(
    {
      name: 'memory-conversations',
      description:
        'List conversation sessions sorted by most recent. ' +
        'Returns conversation metadata including start/end times, memory count, and summary.',
      input: z.object({
        agent: z.string().optional().describe('Agent identifier (default: from config)'),
        since: z.string().optional().describe('Only conversations after this ISO date'),
        limit: z.number().optional().describe('Max results (default: 20)'),
      }),
    },
    async (input) => {
      try {
        const agent = input.agent ?? config.defaultAgent;
        const limit = Math.max(1, Math.min(100, input.limit ?? 20));

        const conditions: string[] = [`agent = '${escapeSimple(agent)}'`];
        if (input.since) {
          conditions.push(`startTime >= '${escapeSimple(input.since)}'`);
        }

        const sql =
          `SELECT conversationId, startTime, endTime, memoryCount, summary` +
          ` FROM Conversation` +
          ` WHERE ${conditions.join(' AND ')}` +
          ` ORDER BY startTime DESC` +
          ` LIMIT ${limit}`;

        const response = await abilities.invoke<{
          success: boolean;
          result?: Array<Record<string, unknown>>;
          error?: string;
        }>('graph-query', {
          database: config.database,
          query: sql,
        });

        if (!response.success) {
          return {
            success: false,
            error: `[memory-conversations] Query failed: ${response.error}`,
            tool: 'memory-conversations',
          };
        }

        const conversations = (response.result ?? []).map((row) => {
          const startTime = (row.startTime as string) ?? '';
          const endTime = (row.endTime as string) ?? '';

          let duration: string | undefined;
          if (startTime && endTime) {
            const ms = new Date(endTime).getTime() - new Date(startTime).getTime();
            if (ms >= 0) {
              const minutes = Math.floor(ms / 60000);
              duration = minutes < 60
                ? `${minutes}m`
                : `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
            }
          }

          return {
            conversationId: (row.conversationId as string) ?? '',
            startTime,
            endTime,
            duration,
            memoryCount: (row.memoryCount as number) ?? 0,
            summary: (row.summary as string) ?? undefined,
          };
        });

        return {
          conversations,
          count: conversations.length,
          agent,
        };
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          success: false,
          error: `[memory-conversations] ${message}`,
          tool: 'memory-conversations',
        };
      }
    },
  );
}

function escapeSimple(str: string): string {
  return str.replace(/'/g, "\\'");
}
