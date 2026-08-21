import { loadConfig, silentLogger, type AppConfig, type Logger } from '@masterclip/shared'
import { AnthropicClient } from './client.js'
import { AgentRunner } from './agents.js'

export * from './client.js'
export * from './agents.js'
export * from './schemas.js'
export * from './vision.js'

export interface AgentLayer {
  client: AnthropicClient
  runner: AgentRunner
  available: boolean
}

/**
 * Builds the agent layer. When no API key is configured the layer reports
 * `available: false` and callers fall back to the deterministic paths — the
 * pipeline runs end to end without Claude, it just stops making the judgement
 * calls Claude was there for.
 */
export function createAgentLayer(config: AppConfig = loadConfig(), logger: Logger = silentLogger): AgentLayer {
  const client = new AnthropicClient({ config, logger })
  return {
    client,
    runner: new AgentRunner({
      client,
      deepModel: config.ANTHROPIC_MODEL,
      fastModel: config.ANTHROPIC_QC_MODEL,
      logger,
    }),
    available: client.isConfigured(),
  }
}
