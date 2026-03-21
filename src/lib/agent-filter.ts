/**
 * Agent filter resolution for cross-agent memory recall.
 *
 * Converts the flexible `agent` parameter (string, array, wildcard)
 * into the correct filter shape for graph-recall and SQL queries.
 */

/**
 * Resolve a flexible agent input into a filter object and display value.
 *
 * - `"*"` → no filter (all agents)
 * - `["a", "b"]` → IN clause
 * - `"a"` → single agent filter
 * - `undefined` → falls back to `defaultAgent`, then single-string logic
 * - `[]` → same as `"*"` (empty array = no filter)
 *
 * @param input - The raw agent parameter from the tool input.
 * @param defaultAgent - Fallback agent ID from config.
 * @returns agentFilter to spread into filters, and agentDisplay for response.
 */
export function resolveAgentFilter(
  input: string | string[] | undefined,
  defaultAgent: string,
): { agentFilter: Record<string, unknown>; agentDisplay: string | string[] } {
  // Undefined → use default
  if (input === undefined || input === null) {
    return {
      agentFilter: { agent: defaultAgent },
      agentDisplay: defaultAgent,
    };
  }

  // Wildcard string → no filter
  if (input === '*') {
    return {
      agentFilter: {},
      agentDisplay: '*',
    };
  }

  // Array handling
  if (Array.isArray(input)) {
    // Empty array → wildcard
    if (input.length === 0) {
      return {
        agentFilter: {},
        agentDisplay: '*',
      };
    }

    // Array with wildcard → wildcard
    if (input.includes('*')) {
      return {
        agentFilter: {},
        agentDisplay: '*',
      };
    }

    // Single-element array → single string
    if (input.length === 1) {
      return {
        agentFilter: { agent: input[0] },
        agentDisplay: input[0],
      };
    }

    // Multi-element array → IN clause (array value in filters)
    return {
      agentFilter: { agent: input },
      agentDisplay: input,
    };
  }

  // Single string
  return {
    agentFilter: { agent: input },
    agentDisplay: input,
  };
}
