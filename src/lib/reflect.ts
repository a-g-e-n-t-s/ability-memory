/**
 * Reflect synthesis — LLM-powered synthesis of retrieved memory fragments.
 *
 * When memory-recall is invoked with `reflect: true`, this module takes the
 * raw fragments and produces a coherent summary that identifies:
 * - Connections between fragments
 * - Contradictions or conflicting information
 * - Temporal patterns and evolution of knowledge
 *
 * Returns both the synthesized summary and raw fragments so the caller can
 * choose which to use.
 */

import type { SignalAbilities } from './graph-types.js';
import type { MemoryConfig } from './config.js';

interface MemoryFragment {
  content: string;
  score?: number;
  importance?: number;
  timestamp?: string;
  agent?: string;
  [key: string]: unknown;
}

export interface ReflectResult {
  summary: string;
  connections: string[];
  contradictions: string[];
  temporalPatterns: string[];
}

const REFLECT_SYSTEM_PROMPT =
  'You are a memory synthesis engine. Given a set of retrieved memory fragments related to a query, ' +
  'produce a coherent synthesis that helps an AI agent understand the full picture.\n\n' +
  'Your output MUST be valid JSON with this structure:\n' +
  '{\n' +
  '  "summary": "A coherent 2-5 sentence synthesis of the key information across all fragments",\n' +
  '  "connections": ["connection between fragment A and B", ...],\n' +
  '  "contradictions": ["fragment X says Y but fragment Z says W", ...],\n' +
  '  "temporalPatterns": ["X changed from A to B over time", ...]\n' +
  '}\n\n' +
  'Rules:\n' +
  '- The summary should be actionable — what does the agent need to know?\n' +
  '- Connections: identify how fragments relate to each other\n' +
  '- Contradictions: flag conflicting information (important for correctness)\n' +
  '- Temporal patterns: note how things evolved if timestamps show progression\n' +
  '- If arrays are empty, use []\n' +
  '- Be concise — each array item should be one sentence max';

export async function reflectOnFragments(
  abilities: SignalAbilities,
  config: MemoryConfig,
  query: string,
  fragments: MemoryFragment[],
): Promise<ReflectResult | null> {
  if (fragments.length === 0) return null;

  const fragmentTexts = fragments.map((f, i) => {
    const meta: string[] = [];
    if (f.timestamp) meta.push(`time: ${f.timestamp}`);
    if (f.agent) meta.push(`agent: ${f.agent}`);
    if (f.importance) meta.push(`importance: ${f.importance}`);
    const metaStr = meta.length > 0 ? ` [${meta.join(', ')}]` : '';
    return `[${i + 1}]${metaStr} ${f.content}`;
  });

  const userPrompt =
    `Query: ${query}\n\nMemory Fragments:\n${fragmentTexts.join('\n\n')}`;

  try {
    const chatResult = await abilities.invoke<{
      success: boolean;
      result?: { choices?: Array<{ message?: { content?: string } }> };
      error?: string;
    }>('graph-chat', {
      model: config.chatModel,
      api_key: config.apiKey,
      messages: [
        { role: 'system', content: REFLECT_SYSTEM_PROMPT },
        { role: 'user', content: userPrompt },
      ],
      temperature: 0.2,
      max_tokens: 800,
    });

    if (!chatResult.success) {
      console.warn(`[reflect] graph-chat failed: ${chatResult.error}`);
      return null;
    }

    const content = chatResult.result?.choices?.[0]?.message?.content ?? '';
    return parseReflectResponse(content);
  } catch (err) {
    console.warn(`[reflect] synthesis failed: ${err instanceof Error ? err.message : err}`);
    return null;
  }
}

function parseReflectResponse(content: string): ReflectResult | null {
  const cleaned = content
    .replace(/```json?\s*/g, '')
    .replace(/```/g, '')
    .trim();

  try {
    const parsed = JSON.parse(cleaned);
    return {
      summary: typeof parsed.summary === 'string' ? parsed.summary : '',
      connections: Array.isArray(parsed.connections) ? parsed.connections : [],
      contradictions: Array.isArray(parsed.contradictions) ? parsed.contradictions : [],
      temporalPatterns: Array.isArray(parsed.temporalPatterns) ? parsed.temporalPatterns : [],
    };
  } catch {
    // If JSON parsing fails, treat the whole content as a summary
    if (content.length > 20) {
      return {
        summary: content.slice(0, 1000),
        connections: [],
        contradictions: [],
        temporalPatterns: [],
      };
    }
    return null;
  }
}
