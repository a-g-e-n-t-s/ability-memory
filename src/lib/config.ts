/**
 * Configuration loader for agent-memory-ability.
 *
 * Resolution order (highest wins):
 *   1. Environment variables  (MEMORY_DATABASE, MEMORY_API_KEY, ...)
 *   2. Vault "models"         (MEMORY_API_KEY, MEMORY_API_URL — encrypted in secrets.toml)
 *   3. `config.yml` file      (walk-up from CWD — memory section)
 *   4. Built-in defaults
 *
 * This is the domain-specific config for agent memory. It extends graph-ability's
 * config with memory-specific settings (summarizationModel, etc.).
 */

import { existsSync, readFileSync } from 'fs';
import { dirname, join } from 'path';
import { load } from 'js-yaml';

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

/** Vault name where model-manager credentials are stored. */
export const VAULT_NAME = 'models';

/** Keys read from the "models" vault — names match the env var overrides. */
export const VAULT_KEYS = ['MEMORY_API_KEY', 'MEMORY_API_URL'] as const;

// ── Walk-up config.yml discovery ──────────────────────────────────────

/**
 * Walk up from CWD looking for config.yml — mirrors vault discovery pattern.
 */
function findConfigFile(filename = 'config.yml'): string | null {
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
        '[agent-memory-ability] No config.yml found — using env vars / vault only',
      );
    }
    return {};
  }

  if (!configLogged) {
    configLogged = true;
    console.log(`[agent-memory-ability] config.yml loaded from ${configPath}`);
  }
  const parsed = load(readFileSync(configPath, 'utf8')) as Record<string, unknown>;
  return (parsed?.memory as Record<string, unknown>) ?? {};
}

// ── Vault loading ─────────────────────────────────────────────────────

/**
 * Load credentials from the "models" vault via secret-ability.
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
        // Key not present in vault — skip silently
      }
    }

    await secrets.disconnect();
    console.log(
      `[agent-memory-ability] Vault "${VAULT_NAME}" loaded — ${Object.keys(credentials).length}/${VAULT_KEYS.length} keys found`,
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
      'kadi_memory',
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
