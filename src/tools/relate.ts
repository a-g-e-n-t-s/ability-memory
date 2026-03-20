/**
 * memory-relate tool — Create typed RelatedTo edges between vertices.
 *
 * Thin wrapper over graph-relate: delegates with optional bidirectional support
 * and weight/relationship metadata.
 */

import { KadiClient, z } from '@kadi.build/core';

import type { MemoryConfig } from '../lib/config.js';
import type { SignalAbilities } from '../lib/graph-types.js';

export function registerRelateTool(
  client: KadiClient,
  config: MemoryConfig,
  abilities: SignalAbilities,
): void {

  client.registerTool(
    {
      name: 'memory-relate',
      description:
        'Create a typed, weighted relationship between any two vertices (memories, topics, entities). ' +
        'Optionally bidirectional.',
      input: z.object({
        fromRid: z.string().describe('Source vertex RID (e.g., "#12:0")'),
        toRid: z.string().describe('Target vertex RID (e.g., "#13:5")'),
        relationship: z.string().optional().describe('Relationship type (default: "related")'),
        weight: z.number().optional().describe('Edge weight 0-1 (default: 0.5)'),
        bidirectional: z.boolean().optional().describe('Create reverse edge too (default: false)'),
      }),
    },
    async (input) => {
      try {
        const relationship = input.relationship ?? 'related';
        const weight = input.weight ?? 0.5;
        const now = new Date().toISOString();

        const properties = {
          type: relationship,
          weight,
          createdAt: now,
        };

        // Delegate to graph-relate
        await abilities.invoke('graph-relate', {
          edgeType: 'RelatedTo',
          fromRid: input.fromRid,
          toRid: input.toRid,
          properties,
          database: config.database,
        });

        if (input.bidirectional) {
          await abilities.invoke('graph-relate', {
            edgeType: 'RelatedTo',
            fromRid: input.toRid,
            toRid: input.fromRid,
            properties,
            database: config.database,
          });
        }

        return {
          created: true,
          from: input.fromRid,
          to: input.toRid,
          relationship,
          weight,
          bidirectional: input.bidirectional ?? false,
        };
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          created: false,
          error: `[memory-relate] ${message}`,
          tool: 'memory-relate',
        };
      }
    },
  );
}
