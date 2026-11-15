import { describeAgentModes, resolveAgentModes, resolveSelectorMode } from '../modules/agent/app/runtimeModes'

// Logs at startup whether the sales agent registers sales or only validates (dry-run).
export default defineNitroPlugin(() => {
  const config = useRuntimeConfig() as any
  console.info(`${describeAgentModes(resolveAgentModes(config))}; selector: ${resolveSelectorMode(config)}`)
})
