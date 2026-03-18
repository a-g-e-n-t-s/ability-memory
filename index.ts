/**
 * ability-memory — Graph Storage, Short-Term Context, Relevance Queries
 *
 * Wraps ArcadeDB for graph operations (vertex/edge CRUD, Cypher queries)
 * plus a file-based short-term context store for conversation history.
 * Includes the original ArcadeAdmin tools for container/database management.
 */

import fs from 'fs';
import path from 'path';
import dotenv from 'dotenv';
import { KadiClient, z } from '@kadi.build/core';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const ArcadeAdmin = require('./arcade-admin.cjs');

dotenv.config();

// ============================================================================
// Configuration
// ============================================================================

const ARCADEDB_URL = process.env.ARCADEDB_URL || 'http://localhost:2480';
const ARCADEDB_DATABASE = process.env.ARCADEDB_DATABASE || 'kadi_memory';
const ARCADEDB_USERNAME = process.env.ARCADEDB_USERNAME || 'root';
const ARCADEDB_PASSWORD = process.env.ARCADEDB_PASSWORD || 'root';
const CONTEXT_DATA_PATH = process.env.CONTEXT_DATA_PATH || './data';
const CONTEXT_MAX_MESSAGES = parseInt(process.env.CONTEXT_MAX_MESSAGES || '50', 10);
const ARCHIVE_THRESHOLD = parseInt(process.env.CONTEXT_ARCHIVE_THRESHOLD || '20', 10);

const DB_AUTH = Buffer.from(`${ARCADEDB_USERNAME}:${ARCADEDB_PASSWORD}`).toString('base64');
const DB_TIMEOUT = 30000;

// ============================================================================
// KadiClient
// ============================================================================

const brokerConfig: Record<string, unknown> = {
  url: process.env.KADI_BROKER_URL || 'ws://localhost:8080/kadi',
};
if (process.env.KADI_NETWORK) {
  brokerConfig.networks = [process.env.KADI_NETWORK];
}

const client = new KadiClient({
  name: 'ability-memory',
  brokers: { default: brokerConfig as any },
});

// Shared ArcadeAdmin instance (for container/db management tools)
let admin: any = null;
function getAdmin(): any {
  if (!admin) admin = new ArcadeAdmin();
  return admin;
}

// ============================================================================
// ArcadeDB Direct Query Helper
// ============================================================================

async function dbQuery(
  command: string,
  language: 'sql' | 'cypher' = 'sql',
  params?: Record<string, unknown>,
): Promise<{ success: boolean; data?: any[]; error?: string }> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), DB_TIMEOUT);

  try {
    const response = await fetch(
      `${ARCADEDB_URL}/api/v1/query/${ARCADEDB_DATABASE}`,
      {
        method: 'POST',
        headers: {
          Authorization: `Basic ${DB_AUTH}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ language, command, ...(params && { params }) }),
        signal: controller.signal,
      },
    );
    clearTimeout(timeoutId);

    if (!response.ok) {
      const errText = await response.text();
      return { success: false, error: `HTTP ${response.status}: ${errText}` };
    }

    const json = (await response.json()) as any;
    if (json.error) return { success: false, error: json.error };
    return { success: true, data: json.result || [] };
  } catch (err: any) {
    clearTimeout(timeoutId);
    if (err.name === 'AbortError') return { success: false, error: `Timeout after ${DB_TIMEOUT}ms` };
    return { success: false, error: err.message };
  }
}

async function dbCommand(
  command: string,
  language: 'sql' | 'cypher' = 'sql',
  params?: Record<string, unknown>,
): Promise<{ success: boolean; data?: any[]; error?: string }> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), DB_TIMEOUT);

  try {
    const response = await fetch(
      `${ARCADEDB_URL}/api/v1/command/${ARCADEDB_DATABASE}`,
      {
        method: 'POST',
        headers: {
          Authorization: `Basic ${DB_AUTH}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ language, command, ...(params && { params }) }),
        signal: controller.signal,
      },
    );
    clearTimeout(timeoutId);

    if (!response.ok) {
      const errText = await response.text();
      return { success: false, error: `HTTP ${response.status}: ${errText}` };
    }

    const json = (await response.json()) as any;
    if (json.error) return { success: false, error: json.error };
    return { success: true, data: json.result || [] };
  } catch (err: any) {
    clearTimeout(timeoutId);
    if (err.name === 'AbortError') return { success: false, error: `Timeout after ${DB_TIMEOUT}ms` };
    return { success: false, error: err.message };
  }
}

// ============================================================================
// Short-Term Context Store (file-based)
// ============================================================================

interface ContextMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
  timestamp: number;
  metadata?: Record<string, unknown>;
}

function contextFilePath(userId: string, channelId: string): string {
  const dir = path.join(CONTEXT_DATA_PATH, userId);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, `${channelId}.json`);
}

function readContext(userId: string, channelId: string): ContextMessage[] {
  const fp = contextFilePath(userId, channelId);
  if (!fs.existsSync(fp)) return [];
  try {
    return JSON.parse(fs.readFileSync(fp, 'utf-8'));
  } catch {
    return [];
  }
}

function writeContext(userId: string, channelId: string, messages: ContextMessage[]): void {
  const fp = contextFilePath(userId, channelId);
  fs.writeFileSync(fp, JSON.stringify(messages, null, 2));
}

// ============================================================================
// Graph Relationship Tools
// ============================================================================

client.registerTool({
  name: 'graph_create_vertex',
  description: 'Create a vertex (node) in the graph database',
  input: z.object({
    type: z.string().describe('Vertex type name (e.g. "Person", "Concept", "Event")'),
    properties: z.string().describe('JSON string of vertex properties'),
  }),
}, async (params) => {
  const props = JSON.parse(params.properties);
  const keys = Object.keys(props);
  const sets = keys.map((k) => `${k} = :${k}`).join(', ');
  const cmd = `CREATE VERTEX ${params.type} SET ${sets}`;
  const result = await dbCommand(cmd, 'sql', props);
  if (!result.success) return { success: false, error: result.error };
  return { success: true, vertex: result.data?.[0], type: params.type };
});

client.registerTool({
  name: 'graph_create_edge',
  description: 'Create an edge (relationship) between two vertices',
  input: z.object({
    type: z.string().describe('Edge type name (e.g. "KNOWS", "RELATED_TO", "PART_OF")'),
    from_rid: z.string().describe('Source vertex RID (e.g. "#12:0")'),
    to_rid: z.string().describe('Target vertex RID (e.g. "#13:0")'),
    properties: z.string().optional().describe('JSON string of edge properties'),
  }),
}, async (params) => {
  let cmd = `CREATE EDGE ${params.type} FROM ${params.from_rid} TO ${params.to_rid}`;
  let edgeParams: Record<string, unknown> = {};
  if (params.properties) {
    const props = JSON.parse(params.properties);
    const keys = Object.keys(props);
    if (keys.length > 0) {
      const sets = keys.map((k) => `${k} = :${k}`).join(', ');
      cmd += ` SET ${sets}`;
      edgeParams = props;
    }
  }
  const result = await dbCommand(cmd, 'sql', edgeParams);
  if (!result.success) return { success: false, error: result.error };
  return { success: true, edge: result.data?.[0], type: params.type };
});

client.registerTool({
  name: 'graph_query',
  description: 'Execute a graph query (SQL or Cypher) against ArcadeDB',
  input: z.object({
    query: z.string().describe('SQL or Cypher query string'),
    language: z.enum(['sql', 'cypher']).optional().describe('Query language (default: sql)'),
    params: z.string().optional().describe('JSON string of query parameters'),
  }),
}, async (p) => {
  const lang = p.language || 'sql';
  const qParams = p.params ? JSON.parse(p.params) : undefined;
  const result = await dbQuery(p.query, lang, qParams);
  if (!result.success) return { success: false, error: result.error };
  return { success: true, results: result.data, count: result.data?.length || 0 };
});

client.registerTool({
  name: 'graph_get_vertex',
  description: 'Get a vertex by RID or query by type and properties',
  input: z.object({
    rid: z.string().optional().describe('Vertex RID (e.g. "#12:0")'),
    type: z.string().optional().describe('Vertex type to search'),
    where: z.string().optional().describe('SQL WHERE clause (e.g. "name = \'Alice\'")'),
    limit: z.number().optional().describe('Max results (default: 10)'),
  }),
}, async (params) => {
  let cmd: string;
  if (params.rid) {
    cmd = `SELECT FROM ${params.rid}`;
  } else if (params.type) {
    cmd = `SELECT FROM ${params.type}`;
    if (params.where) cmd += ` WHERE ${params.where}`;
    cmd += ` LIMIT ${params.limit || 10}`;
  } else {
    return { success: false, error: 'Provide either rid or type' };
  }
  const result = await dbQuery(cmd);
  if (!result.success) return { success: false, error: result.error };
  return { success: true, vertices: result.data, count: result.data?.length || 0 };
});

client.registerTool({
  name: 'graph_delete_vertex',
  description: 'Delete a vertex by RID (also removes connected edges)',
  input: z.object({
    rid: z.string().describe('Vertex RID to delete (e.g. "#12:0")'),
  }),
}, async (params) => {
  const result = await dbCommand(`DELETE VERTEX ${params.rid}`);
  if (!result.success) return { success: false, error: result.error };
  return { success: true, message: `Vertex ${params.rid} deleted` };
});

client.registerTool({
  name: 'graph_delete_edge',
  description: 'Delete an edge by RID',
  input: z.object({
    rid: z.string().describe('Edge RID to delete (e.g. "#20:0")'),
  }),
}, async (params) => {
  const result = await dbCommand(`DELETE EDGE ${params.rid}`);
  if (!result.success) return { success: false, error: result.error };
  return { success: true, message: `Edge ${params.rid} deleted` };
});

client.registerTool({
  name: 'graph_traverse',
  description: 'Traverse the graph from a starting vertex',
  input: z.object({
    start_rid: z.string().describe('Starting vertex RID'),
    direction: z.enum(['out', 'in', 'both']).optional().describe('Traversal direction (default: both)'),
    edge_type: z.string().optional().describe('Filter by edge type'),
    max_depth: z.number().optional().describe('Max traversal depth (default: 3)'),
    limit: z.number().optional().describe('Max results (default: 20)'),
  }),
}, async (params) => {
  const dir = params.direction || 'both';
  const depth = params.max_depth || 3;
  const limit = params.limit || 20;
  const edgeFilter = params.edge_type ? `'${params.edge_type}'` : '';
  const cmd = `TRAVERSE ${dir}(${edgeFilter}) FROM ${params.start_rid} MAXDEPTH ${depth} LIMIT ${limit}`;
  const result = await dbQuery(cmd);
  if (!result.success) return { success: false, error: result.error };
  return { success: true, nodes: result.data, count: result.data?.length || 0 };
});

// ============================================================================
// Short-Term Context Tools
// ============================================================================

client.registerTool({
  name: 'context_push',
  description: 'Push a message into a conversation context (short-term memory)',
  input: z.object({
    user_id: z.string().describe('User identifier'),
    channel_id: z.string().describe('Channel or conversation identifier'),
    role: z.enum(['user', 'assistant', 'system']).describe('Message role'),
    content: z.string().describe('Message content'),
    metadata: z.string().optional().describe('JSON string of extra metadata'),
  }),
}, async (params) => {
  const messages = readContext(params.user_id, params.channel_id);
  const msg: ContextMessage = {
    role: params.role,
    content: params.content,
    timestamp: Date.now(),
    ...(params.metadata && { metadata: JSON.parse(params.metadata) }),
  };
  messages.push(msg);

  // Archive old messages if over threshold
  if (messages.length > CONTEXT_MAX_MESSAGES) {
    const archived = messages.splice(0, messages.length - ARCHIVE_THRESHOLD);
    const archiveDir = path.join(CONTEXT_DATA_PATH, params.user_id, 'archive');
    if (!fs.existsSync(archiveDir)) fs.mkdirSync(archiveDir, { recursive: true });
    const archivePath = path.join(archiveDir, `${params.channel_id}_${Date.now()}.json`);
    fs.writeFileSync(archivePath, JSON.stringify(archived, null, 2));
  }

  writeContext(params.user_id, params.channel_id, messages);
  return { success: true, total_messages: messages.length };
});

client.registerTool({
  name: 'context_get',
  description: 'Get recent conversation context (short-term memory)',
  input: z.object({
    user_id: z.string().describe('User identifier'),
    channel_id: z.string().describe('Channel or conversation identifier'),
    last_n: z.number().optional().describe('Return last N messages (default: all)'),
  }),
}, async (params) => {
  let messages = readContext(params.user_id, params.channel_id);
  if (params.last_n && params.last_n > 0) {
    messages = messages.slice(-params.last_n);
  }
  return { success: true, messages, count: messages.length };
});

client.registerTool({
  name: 'context_clear',
  description: 'Clear conversation context for a user/channel',
  input: z.object({
    user_id: z.string().describe('User identifier'),
    channel_id: z.string().describe('Channel or conversation identifier'),
  }),
}, async (params) => {
  writeContext(params.user_id, params.channel_id, []);
  return { success: true, message: 'Context cleared' };
});

// ============================================================================
// Relevance-Based Query
// ============================================================================

client.registerTool({
  name: 'memory_search',
  description: 'Search graph memory by keywords with relevance scoring. Searches vertex properties for matching terms.',
  input: z.object({
    keywords: z.string().describe('Space-separated search keywords'),
    types: z.string().optional().describe('Comma-separated vertex types to search (default: all)'),
    limit: z.number().optional().describe('Max results (default: 10)'),
  }),
}, async (params) => {
  const keywords = params.keywords.trim().split(/\s+/);
  const limit = params.limit || 10;
  const typeFilter = params.types
    ? params.types.split(',').map((t) => t.trim())
    : null;

  // Build a MATCH query that searches across vertex properties
  // ArcadeDB supports CONTAINSTEXT for full-text search on indexed fields
  // Fallback: use SQL LIKE across common text fields
  const conditions = keywords.map(
    (kw) => `(name ILIKE '%${kw}%' OR description ILIKE '%${kw}%' OR content ILIKE '%${kw}%' OR tags ILIKE '%${kw}%')`,
  );
  const whereClause = conditions.join(' OR ');

  let cmd: string;
  if (typeFilter && typeFilter.length > 0) {
    // Query each type and union results
    const queries = typeFilter.map(
      (t) => `SELECT *, '${t}' as _type FROM ${t} WHERE ${whereClause} LIMIT ${limit}`,
    );
    cmd = queries.join(' UNIONALL ');
  } else {
    // Search V (all vertices)
    cmd = `SELECT FROM V WHERE ${whereClause} LIMIT ${limit}`;
  }

  const result = await dbQuery(cmd);
  if (!result.success) return { success: false, error: result.error };

  // Score results by keyword match count
  const scored = (result.data || []).map((row: any) => {
    const text = JSON.stringify(row).toLowerCase();
    let score = 0;
    for (const kw of keywords) {
      const matches = text.split(kw.toLowerCase()).length - 1;
      score += matches;
    }
    return { ...row, _relevance_score: score };
  });
  scored.sort((a: any, b: any) => b._relevance_score - a._relevance_score);

  return { success: true, results: scored.slice(0, limit), count: scored.length };
});

// ============================================================================
// ArcadeDB Container Management (from ability-arcadedb)
// ============================================================================

client.registerTool({
  name: 'db_start_container',
  description: 'Start the ArcadeDB Docker container',
  input: z.object({
    withTestData: z.boolean().optional().describe('Load test data on startup'),
    restart: z.boolean().optional().describe('Restart if already running'),
  }),
}, async (params) => {
  try {
    const a = getAdmin();
    await a.containerManager.start(params);
    return { success: true, message: `Container started${params.withTestData ? ' with test data' : ''}` };
  } catch (e: any) { return { success: false, error: e.message }; }
});

client.registerTool({
  name: 'db_stop_container',
  description: 'Stop the ArcadeDB Docker container',
  input: z.object({
    force: z.boolean().optional().describe('Force stop without cleanup'),
  }),
}, async (params) => {
  try {
    const a = getAdmin();
    await a.containerManager.stop(params);
    return { success: true, message: 'Container stopped' };
  } catch (e: any) { return { success: false, error: e.message }; }
});

client.registerTool({
  name: 'db_restart_container',
  description: 'Restart the ArcadeDB Docker container',
  input: z.object({
    withTestData: z.boolean().optional().describe('Load test data on restart'),
  }),
}, async (params) => {
  try {
    const a = getAdmin();
    await a.containerManager.restart(params);
    return { success: true, message: 'Container restarted' };
  } catch (e: any) { return { success: false, error: e.message }; }
});

client.registerTool({
  name: 'db_container_status',
  description: 'Get ArcadeDB container status',
  input: z.object({}),
}, async () => {
  try {
    const a = getAdmin();
    const status = await a.containerManager.getStatus();
    return { success: true, ...status };
  } catch (e: any) { return { success: false, error: e.message }; }
});

// ============================================================================
// Database Management (from ability-arcadedb)
// ============================================================================

client.registerTool({
  name: 'db_create',
  description: 'Create a new ArcadeDB database',
  input: z.object({
    name: z.string().describe('Database name'),
    schema: z.string().optional().describe('Optional schema file path'),
  }),
}, async (params) => {
  try {
    const a = getAdmin();
    await a.databaseManager.create(params.name, { schema: params.schema });
    return { success: true, message: `Database "${params.name}" created` };
  } catch (e: any) { return { success: false, error: e.message }; }
});

client.registerTool({
  name: 'db_list',
  description: 'List all ArcadeDB databases',
  input: z.object({}),
}, async () => {
  try {
    const a = getAdmin();
    const databases = await a.databaseManager.list();
    return { success: true, databases, count: databases.length };
  } catch (e: any) { return { success: false, error: e.message }; }
});

client.registerTool({
  name: 'db_drop',
  description: 'Delete an ArcadeDB database',
  input: z.object({
    name: z.string().describe('Database name'),
    confirm: z.boolean().optional().describe('Confirm deletion'),
  }),
}, async (params) => {
  try {
    const a = getAdmin();
    await a.databaseManager.drop(params.name, { confirm: params.confirm });
    return { success: true, message: `Database "${params.name}" dropped` };
  } catch (e: any) { return { success: false, error: e.message }; }
});

client.registerTool({
  name: 'db_backup',
  description: 'Create a backup of an ArcadeDB database',
  input: z.object({
    database: z.string().describe('Database name to backup'),
  }),
}, async (params) => {
  try {
    const a = getAdmin();
    const result = await a.backupManager.create(params.database);
    return { success: true, backupFile: result.backupFile };
  } catch (e: any) { return { success: false, error: e.message }; }
});

client.registerTool({
  name: 'db_health_check',
  description: 'Perform comprehensive ArcadeDB health check',
  input: z.object({}),
}, async () => {
  try {
    const a = getAdmin();
    const health = await a.monitoringManager.healthCheck();
    return { success: true, health };
  } catch (e: any) { return { success: false, error: e.message }; }
});

client.registerTool({
  name: 'db_info',
  description: 'Get detailed information about a database',
  input: z.object({
    name: z.string().describe('Database name'),
  }),
}, async (params) => {
  try {
    const a = getAdmin();
    const info = await a.databaseManager.getInfo(params.name);
    return { success: true, info };
  } catch (e: any) { return { success: false, error: e.message }; }
});

client.registerTool({
  name: 'db_restore',
  description: 'Restore an ArcadeDB database from backup',
  input: z.object({
    database: z.string().describe('Database name to restore to'),
    backupFile: z.string().describe('Backup file path'),
    overwrite: z.boolean().optional().describe('Overwrite existing database'),
  }),
}, async (params) => {
  try {
    const a = getAdmin();
    await a.backupManager.restore(params.database, params.backupFile, { overwrite: params.overwrite });
    return { success: true, message: `Database "${params.database}" restored from ${params.backupFile}` };
  } catch (e: any) { return { success: false, error: e.message }; }
});

client.registerTool({
  name: 'db_list_backups',
  description: 'List all available database backups',
  input: z.object({}),
}, async () => {
  try {
    const a = getAdmin();
    const backups = await a.backupManager.list();
    return { success: true, backups, count: backups.length };
  } catch (e: any) { return { success: false, error: e.message }; }
});

client.registerTool({
  name: 'db_import',
  description: 'Import data into ArcadeDB from a file (JSON, CSV, TSV)',
  input: z.object({
    database: z.string().describe('Database name'),
    filePath: z.string().describe('Import file path'),
    format: z.enum(['json', 'csv', 'tsv']).optional().describe('File format'),
    vertexType: z.string().optional().describe('Vertex type name'),
  }),
}, async (params) => {
  try {
    const a = getAdmin();
    const result = await a.importExportManager.import(params.database, params.filePath, {
      format: params.format, vertexType: params.vertexType,
    });
    return { success: true, imported: result.imported };
  } catch (e: any) { return { success: false, error: e.message }; }
});

client.registerTool({
  name: 'db_export',
  description: 'Export data from ArcadeDB to a file (JSON, CSV, TSV)',
  input: z.object({
    database: z.string().describe('Database name'),
    outputPath: z.string().describe('Output file path'),
    format: z.enum(['json', 'csv', 'tsv']).optional().describe('File format'),
    query: z.string().optional().describe('Optional SQL query for filtering'),
  }),
}, async (params) => {
  try {
    const a = getAdmin();
    const result = await a.importExportManager.export(params.database, params.outputPath, {
      format: params.format, query: params.query,
    });
    return { success: true, exported: result.exported };
  } catch (e: any) { return { success: false, error: e.message }; }
});

// ============================================================================
// Learning Pipeline — Eval → Memory Graph
// ============================================================================

/**
 * Ensures the learning schema (vertex/edge types) exists in ArcadeDB.
 * Idempotent — safe to call multiple times.
 */
async function ensureLearningSchema(): Promise<{ success: boolean; error?: string }> {
  const types = [
    'CREATE VERTEX TYPE EvalResult IF NOT EXISTS',
    'CREATE VERTEX TYPE Pattern IF NOT EXISTS',
    'CREATE VERTEX TYPE Lesson IF NOT EXISTS',
    'CREATE VERTEX TYPE Strategy IF NOT EXISTS',
    'CREATE EDGE TYPE DERIVED_FROM IF NOT EXISTS',
    'CREATE EDGE TYPE APPLIES_TO IF NOT EXISTS',
    'CREATE EDGE TYPE RELATED_TO IF NOT EXISTS',
  ];
  for (const cmd of types) {
    const r = await dbCommand(cmd);
    if (!r.success) return { success: false, error: `Schema creation failed: ${r.error}` };
  }
  return { success: true };
}

client.registerTool({
  name: 'learning_init_schema',
  description: 'Initialize learning pipeline graph schema (EvalResult, Pattern, Lesson, Strategy vertex types and DERIVED_FROM, APPLIES_TO, RELATED_TO edge types). Idempotent.',
  input: z.object({}),
}, async () => {
  return ensureLearningSchema();
});

client.registerTool({
  name: 'learning_ingest_eval',
  description: 'Ingest an evaluation result into the learning graph. Creates an EvalResult vertex and optionally extracts Pattern/Lesson/Strategy vertices linked via DERIVED_FROM edges.',
  input: z.object({
    eval_type: z.string().describe('Type of evaluation (code_diff, test_results, logs, behavior_trace, task_completion, custom, compare)'),
    quest_id: z.string().optional().describe('Quest ID this evaluation belongs to'),
    task_id: z.string().optional().describe('Task ID this evaluation belongs to'),
    agent_id: z.string().optional().describe('Agent that produced the work being evaluated'),
    verdict: z.string().describe('pass, fail, or needs_improvement'),
    score: z.number().describe('Overall score 0-100'),
    summary: z.string().describe('1-2 sentence assessment'),
    criteria: z.string().optional().describe('JSON string of per-criterion scores'),
    suggestions: z.string().optional().describe('JSON string array of improvement suggestions'),
    patterns: z.string().optional().describe('JSON array of pattern objects: [{name, description, category}]'),
    lessons: z.string().optional().describe('JSON array of lesson objects: [{title, insight, context}]'),
    strategies: z.string().optional().describe('JSON array of strategy objects: [{name, description, when_to_use}]'),
  }),
}, async (params) => {
  // Ensure schema exists
  const schema = await ensureLearningSchema();
  if (!schema.success) return schema;

  const now = new Date().toISOString();

  // 1. Create EvalResult vertex
  const evalProps: Record<string, unknown> = {
    eval_type: params.eval_type,
    verdict: params.verdict,
    score: params.score,
    summary: params.summary,
    created_at: now,
  };
  if (params.quest_id) evalProps.quest_id = params.quest_id;
  if (params.task_id) evalProps.task_id = params.task_id;
  if (params.agent_id) evalProps.agent_id = params.agent_id;
  if (params.criteria) evalProps.criteria_json = params.criteria;
  if (params.suggestions) evalProps.suggestions_json = params.suggestions;

  const keys = Object.keys(evalProps);
  const sets = keys.map((k) => `${k} = :${k}`).join(', ');
  const evalResult = await dbCommand(
    `CREATE VERTEX EvalResult SET ${sets}`, 'sql', evalProps,
  );
  if (!evalResult.success) return { success: false, error: evalResult.error };
  const evalRid = evalResult.data?.[0]?.['@rid'];
  if (!evalRid) return { success: false, error: 'Failed to get EvalResult RID' };

  const created: { eval: string; patterns: string[]; lessons: string[]; strategies: string[] } = {
    eval: evalRid, patterns: [], lessons: [], strategies: [],
  };

  // 2. Extract patterns
  if (params.patterns) {
    const items = JSON.parse(params.patterns) as Array<Record<string, string>>;
    for (const p of items) {
      const pResult = await dbCommand(
        `CREATE VERTEX Pattern SET name = :name, description = :desc, category = :cat, created_at = :ts`,
        'sql', { name: p.name, desc: p.description || '', cat: p.category || '', ts: now },
      );
      if (pResult.success && pResult.data?.[0]?.['@rid']) {
        const pRid = pResult.data[0]['@rid'];
        created.patterns.push(pRid);
        await dbCommand(`CREATE EDGE DERIVED_FROM FROM ${pRid} TO ${evalRid}`);
      }
    }
  }

  // 3. Extract lessons
  if (params.lessons) {
    const items = JSON.parse(params.lessons) as Array<Record<string, string>>;
    for (const l of items) {
      const lResult = await dbCommand(
        `CREATE VERTEX Lesson SET title = :title, insight = :insight, context = :ctx, created_at = :ts`,
        'sql', { title: l.title, insight: l.insight || '', ctx: l.context || '', ts: now },
      );
      if (lResult.success && lResult.data?.[0]?.['@rid']) {
        const lRid = lResult.data[0]['@rid'];
        created.lessons.push(lRid);
        await dbCommand(`CREATE EDGE DERIVED_FROM FROM ${lRid} TO ${evalRid}`);
      }
    }
  }

  // 4. Extract strategies
  if (params.strategies) {
    const items = JSON.parse(params.strategies) as Array<Record<string, string>>;
    for (const s of items) {
      const sResult = await dbCommand(
        `CREATE VERTEX Strategy SET name = :name, description = :desc, when_to_use = :wtu, created_at = :ts`,
        'sql', { name: s.name, desc: s.description || '', wtu: s.when_to_use || '', ts: now },
      );
      if (sResult.success && sResult.data?.[0]?.['@rid']) {
        const sRid = sResult.data[0]['@rid'];
        created.strategies.push(sRid);
        await dbCommand(`CREATE EDGE DERIVED_FROM FROM ${sRid} TO ${evalRid}`);
      }
    }
  }

  return { success: true, created };
});

client.registerTool({
  name: 'learning_query_patterns',
  description: 'Query learned patterns from past evaluations. Agents call this before making decisions to leverage past experience.',
  input: z.object({
    category: z.string().optional().describe('Filter by category (e.g. "code_quality", "testing", "architecture")'),
    keywords: z.string().optional().describe('Space-separated keywords to search in pattern name/description'),
    min_eval_score: z.number().optional().describe('Only patterns derived from evals with score >= this value'),
    limit: z.number().optional().describe('Max results (default: 10)'),
  }),
}, async (params) => {
  const limit = params.limit || 10;
  const conditions: string[] = [];
  if (params.category) conditions.push(`category ILIKE '%${params.category}%'`);
  if (params.keywords) {
    const kws = params.keywords.trim().split(/\s+/);
    const kwConds = kws.map(
      (kw) => `(name ILIKE '%${kw}%' OR description ILIKE '%${kw}%')`,
    );
    conditions.push(`(${kwConds.join(' OR ')})`);
  }
  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  const cmd = `SELECT FROM Pattern ${where} ORDER BY created_at DESC LIMIT ${limit}`;
  const result = await dbQuery(cmd);
  if (!result.success) return { success: false, error: result.error };

  // If min_eval_score filter, enrich with eval data
  let patterns = result.data || [];
  if (params.min_eval_score !== undefined) {
    const enriched = [];
    for (const p of patterns) {
      const rid = p['@rid'];
      const evalQ = await dbQuery(
        `SELECT FROM (TRAVERSE out('DERIVED_FROM') FROM ${rid} MAXDEPTH 1) WHERE @type = 'EvalResult' AND score >= ${params.min_eval_score}`,
      );
      if (evalQ.success && evalQ.data && evalQ.data.length > 0) {
        enriched.push({ ...p, _source_eval_score: evalQ.data[0].score });
      }
    }
    patterns = enriched;
  }

  return { success: true, patterns, count: patterns.length };
});

client.registerTool({
  name: 'learning_query_lessons',
  description: 'Query lessons learned from past evaluations. Returns insights and context from previous experiences.',
  input: z.object({
    keywords: z.string().optional().describe('Space-separated keywords to search'),
    eval_type: z.string().optional().describe('Filter by source eval type (code_diff, test_results, etc.)'),
    limit: z.number().optional().describe('Max results (default: 10)'),
  }),
}, async (params) => {
  const limit = params.limit || 10;
  const conditions: string[] = [];
  if (params.keywords) {
    const kws = params.keywords.trim().split(/\s+/);
    const kwConds = kws.map(
      (kw) => `(title ILIKE '%${kw}%' OR insight ILIKE '%${kw}%' OR context ILIKE '%${kw}%')`,
    );
    conditions.push(`(${kwConds.join(' OR ')})`);
  }
  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  let cmd = `SELECT FROM Lesson ${where} ORDER BY created_at DESC LIMIT ${limit}`;
  const result = await dbQuery(cmd);
  if (!result.success) return { success: false, error: result.error };

  let lessons = result.data || [];

  // Filter by eval_type if specified (traverse to source EvalResult)
  if (params.eval_type) {
    const filtered = [];
    for (const l of lessons) {
      const rid = l['@rid'];
      const evalQ = await dbQuery(
        `SELECT FROM (TRAVERSE out('DERIVED_FROM') FROM ${rid} MAXDEPTH 1) WHERE @type = 'EvalResult' AND eval_type = '${params.eval_type}'`,
      );
      if (evalQ.success && evalQ.data && evalQ.data.length > 0) {
        filtered.push(l);
      }
    }
    lessons = filtered;
  }

  return { success: true, lessons, count: lessons.length };
});

client.registerTool({
  name: 'learning_query_strategies',
  description: 'Query strategies derived from past evaluations. Returns actionable approaches agents can apply.',
  input: z.object({
    keywords: z.string().optional().describe('Space-separated keywords to search'),
    limit: z.number().optional().describe('Max results (default: 10)'),
  }),
}, async (params) => {
  const limit = params.limit || 10;
  const conditions: string[] = [];
  if (params.keywords) {
    const kws = params.keywords.trim().split(/\s+/);
    const kwConds = kws.map(
      (kw) => `(name ILIKE '%${kw}%' OR description ILIKE '%${kw}%' OR when_to_use ILIKE '%${kw}%')`,
    );
    conditions.push(`(${kwConds.join(' OR ')})`);
  }
  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  const cmd = `SELECT FROM Strategy ${where} ORDER BY created_at DESC LIMIT ${limit}`;
  const result = await dbQuery(cmd);
  if (!result.success) return { success: false, error: result.error };
  return { success: true, strategies: result.data || [], count: result.data?.length || 0 };
});

client.registerTool({
  name: 'learning_get_eval_history',
  description: 'Get evaluation history for a quest, task, or agent. Useful for tracking improvement over time.',
  input: z.object({
    quest_id: z.string().optional().describe('Filter by quest ID'),
    task_id: z.string().optional().describe('Filter by task ID'),
    agent_id: z.string().optional().describe('Filter by agent ID'),
    eval_type: z.string().optional().describe('Filter by eval type'),
    verdict: z.string().optional().describe('Filter by verdict (pass, fail, needs_improvement)'),
    limit: z.number().optional().describe('Max results (default: 20)'),
  }),
}, async (params) => {
  const limit = params.limit || 20;
  const conditions: string[] = [];
  if (params.quest_id) conditions.push(`quest_id = '${params.quest_id}'`);
  if (params.task_id) conditions.push(`task_id = '${params.task_id}'`);
  if (params.agent_id) conditions.push(`agent_id = '${params.agent_id}'`);
  if (params.eval_type) conditions.push(`eval_type = '${params.eval_type}'`);
  if (params.verdict) conditions.push(`verdict = '${params.verdict}'`);
  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  const cmd = `SELECT FROM EvalResult ${where} ORDER BY created_at DESC LIMIT ${limit}`;
  const result = await dbQuery(cmd);
  if (!result.success) return { success: false, error: result.error };
  return { success: true, evaluations: result.data || [], count: result.data?.length || 0 };
});

client.registerTool({
  name: 'learning_link_related',
  description: 'Create a RELATED_TO edge between two learning vertices (Pattern, Lesson, Strategy). Builds a knowledge graph of interconnected insights.',
  input: z.object({
    from_rid: z.string().describe('Source vertex RID'),
    to_rid: z.string().describe('Target vertex RID'),
    relationship: z.string().optional().describe('Description of the relationship'),
    strength: z.number().optional().describe('Relationship strength 0-1 (default: 0.5)'),
  }),
}, async (params) => {
  const props: Record<string, unknown> = {
    strength: params.strength ?? 0.5,
    created_at: new Date().toISOString(),
  };
  if (params.relationship) props.relationship = params.relationship;
  const keys = Object.keys(props);
  const sets = keys.map((k) => `${k} = :${k}`).join(', ');
  const result = await dbCommand(
    `CREATE EDGE RELATED_TO FROM ${params.from_rid} TO ${params.to_rid} SET ${sets}`,
    'sql', props,
  );
  if (!result.success) return { success: false, error: result.error };
  return { success: true, edge: result.data?.[0] };
});

// ============================================================================
// Startup
// ============================================================================

const mode = process.env.KADI_MODE || process.argv[2] || 'stdio';

console.log(`[ability-memory] ArcadeDB: ${ARCADEDB_URL}/${ARCADEDB_DATABASE}`);
console.log(`[ability-memory] Starting in ${mode} mode...`);

client.serve(mode as any);
