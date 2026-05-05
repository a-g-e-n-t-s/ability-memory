/**
 * Configuration loader for agent-memory-ability.
 *
 * Resolution order (highest wins):
 *   1. Environment variables  (MEMORY_DATABASE, MEMORY_API_KEY, ...)
 *   2. Vault "models"         (MEMORY_API_KEY, MEMORY_API_URL — encrypted in secrets.toml)
 *   3. `config.toml` file     (walk-up from CWD — [memory] section)
 *   4. Built-in defaults
 *
 * This is the domain-specific config for agent memory. It extends graph-ability's
 * config with memory-specific settings (summarizationModel, etc.).
 */

import { existsSync, readFileSync } from 'fs';
import { dirname, join } from 'path';

// ── Lightweight TOML parser (same pattern as agents-library/src/utils/config.ts) ──

function parseTomlValue(raw: string): unknown {
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  if (/^-?\d+$/.test(raw)) return parseInt(raw, 10);
  if (/^-?\d+\.\d+$/.test(raw)) return parseFloat(raw);
  if (raw.startsWith('"') && raw.endsWith('"')) return raw.slice(1, -1);
  if (raw.startsWith("'") && raw.endsWith("'")) return raw.slice(1, -1);
  if (raw.startsWith('[') && raw.endsWith(']')) {
    return raw.slice(1, -1).split(',').map(s => parseTomlValue(s.trim()));
  }
  return raw;
}

function parseSimpleToml(content: string): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  let currentSection = '';

  for (const rawLine of content.split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;

    const sectionMatch = line.match(/^\[([a-zA-Z0-9._-]+)\]$/);
    if (sectionMatch) {
      currentSection = sectionMatch[1];
      continue;
    }

    const kvMatch = line.match(/^([a-zA-Z0-9_-]+)\s*=\s*(.+)$/);
    if (!kvMatch) continue;

    const key = kvMatch[1];
    const rawValue = kvMatch[2].trim();
    const fullKey = currentSection ? `${currentSection}.${key}` : key;
    result[fullKey] = parseTomlValue(rawValue);
  }

  return result;
}

/** Track whether config has already been logged to avoid log spam. */
let configLogged = false;

export type Transport = 'broker' | 'api';

export interface MemoryConfig {
  database: string;
  embeddingModel: string;
  extractionModel: string;
  summarizationModel: string;
  chatModel: string;
  defaultAgent: string;
  apiKey?: string;
  apiUrl?: string;
  embeddingTransport: Transport;
  chatTransport: Transport;
}

// ── Vault key names ───────────────────────────────────────────────────

/** Vault name for model-manager credentials. */
export const VAULT_NAME = 'model-manager';

/** Keys read from the vault. */
export const VAULT_KEYS = ['MODEL_MANAGER_BASE_URL', 'MODEL_MANAGER_API_KEY'] as const;

// ── Walk-up config.yml discovery ──────────────────────────────────────

/**
 * Walk up from CWD looking for config.yml — mirrors vault discovery pattern.
 */
function findConfigFile(filename = 'config.toml'): string | null {
  let dir = process.cwd();
  while (true) {
    const candidate = join(dir, filename);
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

/**
 * Load the `memory` section from the nearest `config.yml`.
 */
function loadConfigSection(): Record<string, unknown> {
  const configPath = findConfigFile();
  if (!configPath) {
    if (!configLogged) {
      configLogged = true;
      console.warn(
        '[agent-memory-ability] No config.toml found — using env vars / vault only',
      );
    }
    return {};
  }

  if (!configLogged) {
    configLogged = true;
    console.log(`[agent-memory-ability] config.toml loaded from ${configPath}`);
  }

  const content = readFileSync(configPath, 'utf8');
  const flat = parseSimpleToml(content);

  // Extract memory.* keys into a plain object
  const section: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(flat)) {
    if (key.startsWith('memory.')) {
      section[key.slice('memory.'.length)] = value;
    }
  }
  return section;
}

// ── Vault loading ─────────────────────────────────────────────────────

/**
 * Load credentials from the "model-manager" vault via secret-ability.
 */
export async function loadFromVault(
  client: any,
): Promise<Record<string, string>> {
  const credentials: Record<string, string> = {};

  try {
    const secrets = await client.loadNative('secret-ability');

    for (const key of VAULT_KEYS) {
      try {
        const result = await secrets.invoke('get', {
          vault: VAULT_NAME,
          key,
        });
        if (result?.value) {
          credentials[key] = result.value;
        }
      } catch {
        // Not present — skip
      }
    }

    // Normalize to internal key names
    if (credentials['MODEL_MANAGER_BASE_URL']) {
      credentials['MEMORY_API_URL'] = credentials['MODEL_MANAGER_BASE_URL'];
    }
    if (credentials['MODEL_MANAGER_API_KEY']) {
      credentials['MEMORY_API_KEY'] = credentials['MODEL_MANAGER_API_KEY'];
    }

    await secrets.disconnect();
    const found = Object.keys(credentials).filter(k => VAULT_KEYS.includes(k as any)).length;
    console.log(
      `[agent-memory-ability] Vault "${VAULT_NAME}" loaded — ${found}/${VAULT_KEYS.length} keys found`,
    );
  } catch (err: any) {
    console.warn(
      '[agent-memory-ability] secret-ability not available — using env vars / config only',
    );
    console.warn('[agent-memory-ability] loadNative error:', err?.message ?? err);
  }

  return credentials;
}

// ── Public API ────────────────────────────────────────────────────────

/**
 * Build the fully-resolved MemoryConfig (synchronous, no vault).
 */
export function loadMemoryConfig(): MemoryConfig {
  return buildConfig({});
}

/**
 * Build the fully-resolved MemoryConfig with vault credentials.
 */
export async function loadMemoryConfigWithVault(
  client: any,
): Promise<MemoryConfig> {
  const vaultSecrets = await loadFromVault(client);
  return buildConfig(vaultSecrets);
}

/**
 * Internal config builder.
 */
function buildConfig(vault: Record<string, string>): MemoryConfig {
  const file = loadConfigSection();

  return {
    database:
      process.env.MEMORY_DATABASE ??
      (file.database as string) ??
      'agents_memory',
    embeddingModel:
      process.env.MEMORY_EMBEDDING_MODEL ??
      (file.embedding_model as string) ??
      'text-embedding-3-small',
    extractionModel:
      process.env.MEMORY_EXTRACTION_MODEL ??
      (file.extraction_model as string) ??
      'gpt-5-nano',
    summarizationModel:
      process.env.MEMORY_SUMMARIZATION_MODEL ??
      (file.summarization_model as string) ??
      'gpt-5-mini',
    chatModel:
      process.env.MEMORY_CHAT_MODEL ??
      (file.chat_model as string) ??
      'gpt-5-mini',
    defaultAgent:
      process.env.MEMORY_DEFAULT_AGENT ??
      (file.default_agent as string) ??
      'default',
    apiKey:
      process.env.MEMORY_API_KEY ??
      vault['MEMORY_API_KEY'] ??
      undefined,
    apiUrl:
      process.env.MEMORY_API_URL ??
      vault['MEMORY_API_URL'] ??
      undefined,
    embeddingTransport:
      (process.env.MEMORY_EMBEDDING_TRANSPORT ??
        (file.embedding_transport as string) ??
        'api') as Transport,
    chatTransport:
      (process.env.MEMORY_CHAT_TRANSPORT ??
        (file.chat_transport as string) ??
        'api') as Transport,
  };
}
