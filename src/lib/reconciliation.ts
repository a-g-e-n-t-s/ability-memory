/**
 * Fact extraction and reconciliation module for ability-memory.
 *
 * Implements mem0-style write path:
 *   1. extractFacts() — LLM extracts atomic facts from input text
 *   2. reconcileFacts() — LLM compares new facts against existing memories (task 2.1.2)
 *
 * Reference: mem0/configs/prompts.py (FACT_RETRIEVAL_PROMPT, DEFAULT_UPDATE_MEMORY_PROMPT)
 */

import type { SignalAbilities } from './graph-types.js';
import type { MemoryConfig } from './config.js';

// ── Types ─────────────────────────────────────────────────────────────

export interface FactEntity {
  name: string;
  type: string;
}

export interface Fact {
  text: string;
  entities: FactEntity[];
  topics: string[];
}

export type ReconciliationAction = 'ADD' | 'UPDATE' | 'DELETE' | 'NONE';

export interface ReconciliationEntry {
  fact: Fact;
  action: ReconciliationAction;
  targetId?: string;
  mergedText?: string;
  oldText?: string;
}

export interface ReconciliationResult {
  entries: ReconciliationEntry[];
  existingMemories: ExistingMemory[];
  durationMs: number;
}

export interface ExistingMemory {
  id: string;
  rid: string;
  content: string;
  score: number;
}

// ── Prompts ───────────────────────────────────────────────────────────

const FACT_EXTRACTION_SYSTEM_PROMPT = `You are a fact extraction engine for an agent memory system. Your role is to decompose input text into atomic, self-contained facts.

For each fact, also identify:
- entities: named things mentioned (people, projects, tools, companies, concepts) with their type
- topics: broad categories the fact belongs to

Rules:
- Each fact must be a single, atomic statement that can stand alone
- Preserve specific values: dates, versions, names, numbers
- Convert relative dates to absolute when possible (today's date will be provided)
- Do not infer or add information not present in the input
- If the input contains no meaningful facts, return an empty array
- Detect the language of the input and record facts in the same language

Return JSON format:
{"facts": [{"text": "...", "entities": [{"name": "...", "type": "..."}], "topics": ["..."]}]}

Entity types: person, project, tool, company, concept, location, event, version, agent

Examples:

Input: "We deployed DaemonAgent v0.2.0 to production on 2026-05-01, replacing v0.1.9"
Output: {"facts": [
  {"text": "DaemonAgent v0.2.0 was deployed to production on 2026-05-01", "entities": [{"name": "DaemonAgent", "type": "project"}, {"name": "v0.2.0", "type": "version"}], "topics": ["deployment"]},
  {"text": "DaemonAgent v0.2.0 replaces v0.1.9", "entities": [{"name": "DaemonAgent", "type": "project"}, {"name": "v0.2.0", "type": "version"}, {"name": "v0.1.9", "type": "version"}], "topics": ["versioning"]}
]}

Input: "Hi, how are you?"
Output: {"facts": []}

Input: "The artist agent must use blender tools, never hand-write OBJ files"
Output: {"facts": [
  {"text": "Artist agent must use blender tools for 3D content", "entities": [{"name": "artist agent", "type": "agent"}, {"name": "blender", "type": "tool"}], "topics": ["workflow", "constraints"]},
  {"text": "Artist agent must not hand-write OBJ files", "entities": [{"name": "artist agent", "type": "agent"}], "topics": ["workflow", "constraints"]}
]}`;

// ── Implementation ────────────────────────────────────────────────────

export async function extractFacts(
  content: string,
  abilities: SignalAbilities,
  config: MemoryConfig,
): Promise<Fact[]> {
  if (!content.trim()) return [];

  const today = new Date().toISOString().split('T')[0];

  try {
    const result = await abilities.invoke<{ success: boolean; result?: { content?: string; message?: string } }>('graph-chat', {
      messages: [
        { role: 'system', content: FACT_EXTRACTION_SYSTEM_PROMPT },
        { role: 'user', content: `Today's date: ${today}\n\nInput:\n${content}` },
      ],
      model: config.extractionModel,
      temperature: 0,
      max_tokens: 2000,
    });

    if (!result.success || !result.result) {
      console.warn('[reconciliation] graph-chat call failed:', result);
      return [];
    }

    const raw = result.result.content ?? result.result.message ?? '';
    return parseFacts(raw);
  } catch (err) {
    console.error('[reconciliation] extractFacts error:', err);
    return [];
  }
}

// ── Reconciliation Prompt ─────────────────────────────────────────────

const RECONCILIATION_SYSTEM_PROMPT = `You are a memory reconciliation engine. You compare newly extracted facts against existing memories and decide what action to take for each fact.

Actions:
- ADD: The fact is new information not present in any existing memory. Store it.
- UPDATE: The fact enriches or corrects an existing memory. Merge the information.
- DELETE: The fact contradicts an existing memory. The old memory should be invalidated.
- NONE: The fact is already captured by an existing memory. Skip it.

Guidelines:
- If a fact conveys the same meaning as an existing memory (even with different wording), classify as NONE.
- If a fact adds detail to an existing memory (e.g., "likes pizza" → "likes pepperoni pizza"), classify as UPDATE and provide the merged text.
- If a fact directly contradicts an existing memory (e.g., "likes pizza" vs "dislikes pizza"), classify as DELETE for the old memory and ADD for the new fact.
- When updating, preserve the most complete and accurate version.
- Return the existing memory ID (as a string index) for UPDATE and DELETE actions.

Return JSON format:
{"memory": [{"text": "...", "event": "ADD|UPDATE|DELETE|NONE", "id": "<index>", "old_memory": "..."}]}

Where:
- "text" is the final text to store (for ADD/UPDATE) or the existing text (for DELETE/NONE)
- "event" is the action
- "id" is the index of the existing memory being referenced (for UPDATE/DELETE/NONE), or a new unique id for ADD
- "old_memory" is the previous text (only for UPDATE)

Example:
Old Memory:
[{"id": "0", "text": "User likes cheese pizza"}, {"id": "1", "text": "User is a software engineer"}]

New Facts: ["Loves pepperoni pizza", "Is a software engineer at Google"]

Output:
{"memory": [
  {"id": "0", "text": "User likes cheese and pepperoni pizza", "event": "UPDATE", "old_memory": "User likes cheese pizza"},
  {"id": "1", "text": "User is a software engineer at Google", "event": "UPDATE", "old_memory": "User is a software engineer"}
]}`;

// ── Reconciliation Implementation ────────────────────────────────────

export async function reconcileFacts(
  facts: Fact[],
  abilities: SignalAbilities,
  config: MemoryConfig,
): Promise<ReconciliationResult> {
  const startTime = Date.now();

  if (facts.length === 0) {
    return { entries: [], existingMemories: [], durationMs: 0 };
  }

  // Step 1: For each fact, find related existing memories via graph-recall
  const allExisting = new Map<string, ExistingMemory>();

  const recallPromises = facts.map(async (fact) => {
    try {
      const result = await abilities.invoke<{
        results?: Array<{ rid: string; id: string; content: string; score: number }>;
        count?: number;
      }>('graph-recall', {
        query: fact.text,
        vertexType: 'Memory',
        mode: 'hybrid',
        limit: 5,
        database: config.database,
        filters: { agent: config.defaultAgent },
        embedding: {
          model: config.embeddingModel,
          transport: config.embeddingTransport,
          apiUrl: config.apiUrl,
          apiKey: config.apiKey,
        },
      });

      if (result.results) {
        for (const r of result.results) {
          if (!allExisting.has(r.rid)) {
            allExisting.set(r.rid, {
              id: r.rid,
              rid: r.rid,
              content: r.content,
              score: r.score,
            });
          }
        }
      }
    } catch (err) {
      console.warn('[reconciliation] graph-recall failed for fact:', fact.text.slice(0, 50), err);
    }
  });

  await Promise.all(recallPromises);

  const existingMemories = Array.from(allExisting.values());

  // Step 2: If no existing memories, all facts are ADD
  if (existingMemories.length === 0) {
    const entries: ReconciliationEntry[] = facts.map((fact) => ({
      fact,
      action: 'ADD' as const,
    }));
    return { entries, existingMemories, durationMs: Date.now() - startTime };
  }

  // Step 3: Call LLM to classify each fact against existing memories
  const indexedMemories = existingMemories.map((m, i) => ({
    id: String(i),
    text: m.content,
  }));

  const newFacts = facts.map((f) => f.text);

  const prompt = `Old Memory:\n${JSON.stringify(indexedMemories, null, 2)}\n\nNew Facts: ${JSON.stringify(newFacts)}\n\nClassify each new fact and return the result.`;

  try {
    const result = await abilities.invoke<{ success: boolean; result?: { content?: string; message?: string } }>('graph-chat', {
      messages: [
        { role: 'system', content: RECONCILIATION_SYSTEM_PROMPT },
        { role: 'user', content: prompt },
      ],
      model: config.extractionModel,
      temperature: 0,
      max_tokens: 3000,
    });

    if (!result.success || !result.result) {
      console.warn('[reconciliation] reconcile LLM call failed, defaulting to ADD all');
      const entries: ReconciliationEntry[] = facts.map((fact) => ({
        fact,
        action: 'ADD' as const,
      }));
      return { entries, existingMemories, durationMs: Date.now() - startTime };
    }

    const raw = result.result.content ?? result.result.message ?? '';
    const entries = parseReconciliationResponse(raw, facts, existingMemories);

    return { entries, existingMemories, durationMs: Date.now() - startTime };
  } catch (err) {
    console.error('[reconciliation] reconcileFacts LLM error:', err);
    const entries: ReconciliationEntry[] = facts.map((fact) => ({
      fact,
      action: 'ADD' as const,
    }));
    return { entries, existingMemories, durationMs: Date.now() - startTime };
  }
}

// ── Reconciliation Response Parsing ──────────────────────────────────

function parseReconciliationResponse(
  raw: string,
  facts: Fact[],
  existingMemories: ExistingMemory[],
): ReconciliationEntry[] {
  const cleaned = removeCodeBlocks(raw).trim();
  let parsed: { memory?: Array<Record<string, unknown>> };

  try {
    parsed = JSON.parse(cleaned);
  } catch {
    const jsonMatch = raw.match(/\{[\s\S]*"memory"[\s\S]*\}/);
    if (jsonMatch) {
      try {
        parsed = JSON.parse(jsonMatch[0]);
      } catch {
        return facts.map((fact) => ({ fact, action: 'ADD' as const }));
      }
    } else {
      return facts.map((fact) => ({ fact, action: 'ADD' as const }));
    }
  }

  const memoryActions = parsed.memory;
  if (!Array.isArray(memoryActions)) {
    return facts.map((fact) => ({ fact, action: 'ADD' as const }));
  }

  const entries: ReconciliationEntry[] = [];
  const processedFacts = new Set<number>();

  for (const action of memoryActions) {
    const event = String(action.event || 'ADD').toUpperCase() as ReconciliationAction;
    const text = String(action.text || '');
    const idxStr = String(action.id || '');
    const oldMemory = action.old_memory ? String(action.old_memory) : undefined;

    if (!['ADD', 'UPDATE', 'DELETE', 'NONE'].includes(event)) continue;

    // Match this action back to a fact
    const factIdx = facts.findIndex((f, i) =>
      !processedFacts.has(i) && (
        f.text === text ||
        text.toLowerCase().includes(f.text.toLowerCase().slice(0, 30)) ||
        f.text.toLowerCase().includes(text.toLowerCase().slice(0, 30))
      ),
    );

    const fact = factIdx >= 0 ? facts[factIdx] : { text, entities: [], topics: [] };
    if (factIdx >= 0) processedFacts.add(factIdx);

    // Resolve target memory ID
    const memIdx = parseInt(idxStr, 10);
    const targetMemory = !isNaN(memIdx) && memIdx >= 0 && memIdx < existingMemories.length
      ? existingMemories[memIdx]
      : undefined;

    entries.push({
      fact,
      action: event,
      targetId: targetMemory?.rid,
      mergedText: event === 'UPDATE' ? text : undefined,
      oldText: oldMemory ?? targetMemory?.content,
    });
  }

  // Any unprocessed facts default to ADD
  for (let i = 0; i < facts.length; i++) {
    if (!processedFacts.has(i)) {
      entries.push({ fact: facts[i], action: 'ADD' });
    }
  }

  return entries;
}

// ── Parsing ───────────────────────────────────────────────────────────

function parseFacts(raw: string): Fact[] {
  const cleaned = removeCodeBlocks(raw).trim();
  if (!cleaned) return [];

  try {
    const parsed = JSON.parse(cleaned);
    const facts = parsed.facts;
    if (!Array.isArray(facts)) return [];

    return facts
      .filter((f: unknown) => f && typeof f === 'object' && 'text' in (f as object))
      .map((f: Record<string, unknown>) => ({
        text: String(f.text || ''),
        entities: normalizeEntities(f.entities),
        topics: normalizeTopics(f.topics),
      }))
      .filter((f) => f.text.length > 0);
  } catch {
    // Try extracting JSON from chatty LLM output
    const jsonMatch = raw.match(/\{[\s\S]*"facts"[\s\S]*\}/);
    if (jsonMatch) {
      try {
        const parsed = JSON.parse(jsonMatch[0]);
        if (Array.isArray(parsed.facts)) {
          return parsed.facts
            .filter((f: unknown) => f && typeof f === 'object' && 'text' in (f as object))
            .map((f: Record<string, unknown>) => ({
              text: String(f.text || ''),
              entities: normalizeEntities(f.entities),
              topics: normalizeTopics(f.topics),
            }))
            .filter((f) => f.text.length > 0);
        }
      } catch { /* give up */ }
    }
    return [];
  }
}

function removeCodeBlocks(text: string): string {
  return text.replace(/```(?:json)?\s*([\s\S]*?)```/g, '$1').trim();
}

function normalizeEntities(raw: unknown): FactEntity[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((e) => e && typeof e === 'object' && 'name' in e)
    .map((e: Record<string, unknown>) => ({
      name: String(e.name || ''),
      type: String(e.type || 'concept'),
    }))
    .filter((e) => e.name.length > 0);
}

function normalizeTopics(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter((t) => typeof t === 'string' && t.length > 0) as string[];
}
