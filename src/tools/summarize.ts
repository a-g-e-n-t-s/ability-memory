/**
 * memory-summarize tool — Generate a conversation summary via LLM.
 *
 * Domain-specific tool that:
 *   1. Recalls all memories in a conversation
 *   2. Sends them to graph-chat for summarization
 *   3. Stores the summary on the Conversation vertex
 *
 * Uses graph-ability's graph-chat tool for LLM completion.
 */

import { KadiClient, z } from '@kadi.build/core';

import type { MemoryConfig } from '../lib/config.js';
import type { SignalAbilities } from '../lib/graph-types.js';

export function registerSummarizeTool(
  client: KadiClient,
  config: MemoryConfig,
  abilities: SignalAbilities,
): void {

  client.registerTool(
    {
      name: 'memory-summarize',
      description:
        'Generate a 2-4 sentence summary of all memories in a conversation via LLM. ' +
        'Stores the summary on the Conversation vertex.',
      input: z.object({
        conversationId: z.string().describe('Conversation ID to summarize'),
      }),
    },
    async (input) => {
      try {
        const database = config.database;
        const safeConvId = escapeSimple(input.conversationId);

        // Step 1: Fetch all memories in this conversation
        const memorySql =
          `SELECT content, timestamp FROM Memory` +
          ` WHERE conversationId = '${safeConvId}'` +
          ` ORDER BY timestamp ASC`;

        const memoryResult = await abilities.invoke<{
          success: boolean;
          result?: Array<Record<string, unknown>>;
        }>('graph-query', {
          database,
          query: memorySql,
        });

        if (!memoryResult.success || !memoryResult.result || memoryResult.result.length === 0) {
          return {
            summarized: false,
            error: `[memory-summarize] No memories found for conversation "${input.conversationId}". Query: ${memorySql}. Result: ${JSON.stringify(memoryResult).slice(0, 200)}`,
            tool: 'memory-summarize',
          };
        }

        // Step 2: Build content for summarization
        const memoryTexts = memoryResult.result.map(
          (row) => (row.content as string) ?? '',
        );
        const combined = memoryTexts.join('\n\n');

        // Step 3: Generate summary via graph-chat
        // graph-chat wraps the raw LLM response in { success, result: <response> }
        const chatResult = await abilities.invoke<{
          success: boolean;
          result?: { choices?: Array<{ message?: { content?: string } }> };
          error?: string;
        }>('graph-chat', {
          model: config.summarizationModel,
          api_key: config.apiKey,
          messages: [
            {
              role: 'system',
              content:
                'Summarize the following conversation memories in 2-4 concise sentences. ' +
                'Focus on key decisions, outcomes, and important information discussed.',
            },
            { role: 'user', content: combined },
          ],
          temperature: 0.3,
          max_tokens: 300,
        });

        if (!chatResult.success) {
          return {
            summarized: false,
            error: `[memory-summarize] graph-chat failed: ${chatResult.error}`,
            tool: 'memory-summarize',
          };
        }

        const summary = chatResult.result?.choices?.[0]?.message?.content ?? '';

        if (!summary) {
          return {
            summarized: false,
            error: '[memory-summarize] LLM returned empty summary',
            tool: 'memory-summarize',
          };
        }

        // Step 4: Store summary on Conversation vertex
        const updateResult = await abilities.invoke<{ success: boolean; error?: string }>('graph-command', {
          database,
          command:
            `UPDATE Conversation SET summary = '${escapeSimple(summary)}'` +
            ` WHERE conversationId = '${safeConvId}'`,
        });

        if (!updateResult.success) {
          return {
            summarized: false,
            error: `[memory-summarize] Failed to store summary: ${updateResult.error}`,
            tool: 'memory-summarize',
          };
        }

        return {
          summarized: true,
          conversationId: input.conversationId,
          memoryCount: memoryTexts.length,
          summary,
        };
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          summarized: false,
          error: `[memory-summarize] ${message}`,
          tool: 'memory-summarize',
        };
      }
    },
  );
}

function escapeSimple(str: string): string {
  return str.replace(/'/g, "\\'");
}
