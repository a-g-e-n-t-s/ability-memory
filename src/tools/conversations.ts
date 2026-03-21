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
        agent: z.union([z.string(), z.array(z.string())]).optional()
          .describe('Agent filter: string, array, or "*" for all agents (default: from config)'),
        since: z.string().optional().describe('Only conversations after this ISO date'),
        limit: z.number().optional().describe('Max results (default: 20)'),
      }),
    },
    async (input) => {
      try {
        const limit = Math.max(1, Math.min(100, input.limit ?? 20));

        // Build agent condition based on input type
        const agentInput = input.agent ?? config.defaultAgent;
        let agentCondition: string;
        let agentDisplay: string | string[];

        if (agentInput === '*') {
          // Wildcard — no agent filter
          agentCondition = '';
          agentDisplay = '*';
        } else if (Array.isArray(agentInput)) {
          if (agentInput.length === 0 || agentInput.includes('*')) {
            agentCondition = '';
            agentDisplay = '*';
          } else if (agentInput.length === 1) {
            agentCondition = `agent = '${escapeSimple(agentInput[0])}'`;
            agentDisplay = agentInput[0];
          } else {
            const escaped = agentInput.map((a) => `'${escapeSimple(a)}'`).join(', ');
            agentCondition = `agent IN [${escaped}]`;
            agentDisplay = agentInput;
          }
        } else {
          agentCondition = `agent = '${escapeSimple(agentInput)}'`;
          agentDisplay = agentInput;
        }

        const conditions: string[] = [];
        if (agentCondition) {
          conditions.push(agentCondition);
        }
        if (input.since) {
          conditions.push(`startTime >= '${escapeSimple(input.since)}'`);
        }

        const whereClause = conditions.length > 0
          ? ` WHERE ${conditions.join(' AND ')}`
          : '';

        const sql =
          `SELECT conversationId, startTime, endTime, memoryCount, summary` +
          ` FROM Conversation` +
          whereClause +
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
          agent: agentDisplay,
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
