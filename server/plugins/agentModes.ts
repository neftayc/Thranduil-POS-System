import { describeAgentModes, resolveAgentModes } from '../modules/agent/app/runtimeModes'

// Logs at startup whether the sales agent registers sales or only validates (dry-run).
export default defineNitroPlugin(() => {
  console.info(describeAgentModes(resolveAgentModes(useRuntimeConfig() as any)))
})
