/**
 * Safety modes of the sales agent, resolved AT RUNTIME.
 *
 * nuxt.config.ts reads process.env when the app is BUILT; in `node .output/server/index.mjs`
 * a POS_AGENT_DRY_RUN=1 set at launch would not reach runtimeConfig. These modes therefore look
 * at every source when the request is served and fail in the safe direction:
 *   - dry-run is ON if ANY source asks for it (runtimeConfig, POS_AGENT_DRY_RUN, NUXT_POS_AGENT_DRY_RUN);
 *   - background search indexing (writes to the database) is ON only if explicitly requested by
 *     some source AND dry-run is off.
 */
export type AgentModes = { dryRun: boolean; autoindex: boolean }
type Env = Record<string, string | undefined>

/** Boolean flag: true, '1', 'true', 'yes', 'on' (env values arrive as strings). */
export const isFlagOn = (value: unknown) => value === true || ['1', 'true', 'yes', 'on'].includes(String(value ?? '').trim().toLowerCase())

export const resolveAgentModes = (config: { posAgentDryRun?: unknown; posAgentSearchAutoindex?: unknown }, env: Env = process.env): AgentModes => {
  const dryRun = [config.posAgentDryRun, env.POS_AGENT_DRY_RUN, env.NUXT_POS_AGENT_DRY_RUN].some(isFlagOn)
  const autoindexRequested = [config.posAgentSearchAutoindex, env.POS_AGENT_SEARCH_AUTOINDEX, env.NUXT_POS_AGENT_SEARCH_AUTOINDEX].some(isFlagOn)
  return { dryRun, autoindex: autoindexRequested && !dryRun }
}

export const describeAgentModes = (modes: AgentModes) =>
  `[agente de ventas] modo: ${modes.dryRun ? 'SOLO VALIDACIÓN (dry-run): no registra ventas' : 'REAL: registra ventas'}; ` +
  `indexado de búsqueda en segundo plano: ${modes.autoindex ? 'ENCENDIDO (escribe en la base)' : 'apagado (solo lectura)'}`

/** Keeps ONE instance per process for the same configuration key (rebuilt only if the key changes). */
export const memoizeByKey = <T>(factory: (key: string) => T) => {
  let cache: { key: string; value: T } | null = null
  return (key: string): T => {
    if (!cache || cache.key !== key) cache = { key, value: factory(key) }
    return cache.value
  }
}
