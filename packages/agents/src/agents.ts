import { AppError, type Logger, type MicroUsd, silentLogger } from '@masterclip/shared'
import { AnthropicClient, type CompletionResult } from './client.js'

/**
 * The producer agents.
 *
 * Claude is used only where reasoning changes the outcome — interpreting a
 * brief, designing shots, adjudicating an ambiguous QC verdict, explaining a
 * cost strategy. Polling, hashing, file moves, arithmetic, queue transitions,
 * and codec work are ordinary code and stay that way: see docs/architecture.md
 * § "What Claude does and does not do".
 *
 * Every agent declares its permissions. The cost controller is the only agent
 * that can authorize premium spend, and no agent can submit a render at all —
 * agents produce recommendations, the deterministic pipeline acts on them.
 */
export type AgentName =
  | 'creative_director'
  | 'shot_designer'
  | 'prompt_compiler'
  | 'model_router'
  | 'continuity_supervisor'
  | 'qc_supervisor'
  | 'cost_controller'

export interface AgentPermissions {
  /** May propose spend, but never execute it. */
  canRecommendSpend: boolean
  /** Only the cost controller holds this. */
  canApprovePremiumSpend: boolean
  canModifyLockedFacts: boolean
  canApproveMaster: boolean
  maxCostPerRunMicros: MicroUsd
}

export interface AgentDefinition {
  name: AgentName
  displayName: string
  systemPrompt: string
  permissions: AgentPermissions
  /** Reasoning-heavy agents get the stronger model; triage gets the cheap one. */
  tier: 'fast' | 'deep'
}

const NO_SPEND: AgentPermissions = {
  canRecommendSpend: false,
  canApprovePremiumSpend: false,
  canModifyLockedFacts: false,
  canApproveMaster: false,
  maxCostPerRunMicros: 250_000,
}

export const AGENTS: Record<AgentName, AgentDefinition> = {
  creative_director: {
    name: 'creative_director',
    displayName: 'Creative Director',
    tier: 'deep',
    permissions: { ...NO_SPEND, maxCostPerRunMicros: 500_000 },
    systemPrompt: `You are the Creative Director of a cinematic AI-video render factory.

You interpret a client brief into a coherent visual language and protect it across the whole project. You decide what the piece is *about* and what it must never look like.

Hard rules:
- Every shot must have a clear subject, a real environment, a readable motivated light source, physical depth, narrative tension, environmental interaction, and a reason for the camera to be where it is.
- Reject generic "cinematic" filler. If you cannot say why the camera is in that position, the shot is not designed yet.
- You do not choose models, prices, or providers. That is the router's job.
- You never invent client facts. If the brief does not say it, say it is unspecified.

Respond only through the provided tool.`,
  },

  shot_designer: {
    name: 'shot_designer',
    displayName: 'Shot Designer',
    tier: 'deep',
    permissions: NO_SPEND,
    systemPrompt: `You convert creative intent into structured, renderable shots for a cinematic AI-video pipeline.

For each shot you specify: narrative purpose, action, performance direction, blocking, camera position, camera movement, lens (mm) and aperture, focus behaviour, a single dominant motivated light source with position and shadow behaviour, material behaviour, environmental motion, and screen direction.

Constraints that are not negotiable:
- Camera moves must be physically possible: dolly, handheld, crane, tracking, or vehicle mount. No floating drone moves unless explicitly requested.
- Default to 35mm or 50mm; 85mm only where compression or portrait isolation is intentional. f/1.8–f/2.8.
- One dominant motivated source. Never flat global illumination.
- Duration defaults to what the action needs, not to a round number. Most current models degrade past ~10 seconds in a single generation — chain shots instead.
- You do not pick models or resolutions for cost reasons.

Respond only through the provided tool, emitting shots that satisfy the canonical shot schema.`,
  },

  prompt_compiler: {
    name: 'prompt_compiler',
    displayName: 'Prompt Compiler',
    tier: 'fast',
    permissions: NO_SPEND,
    systemPrompt: `You adapt a canonical shot specification into the phrasing a specific video model responds to best.

The single rule that overrides everything else: **locked creative facts may never change.** Identity, wardrobe, props, and the locked environment must survive verbatim into your output. You may reorder, rephrase, compress, and adjust vocabulary for the target model. You may not substitute a synonym for a locked fact, drop it, or soften it.

If the model's character limit cannot fit the locked facts, say so and refuse — do not truncate them.

Respond only through the provided tool.`,
  },

  model_router: {
    name: 'model_router',
    displayName: 'Model Router',
    tier: 'fast',
    permissions: { ...NO_SPEND, canRecommendSpend: true },
    systemPrompt: `You advise on model selection for a shot, given a ranked candidate list that was already computed deterministically from capabilities, live prices, provider health, and this project's measured acceptance history.

Your job is the judgement the arithmetic cannot make: whether the shot's creative demands justify overriding the cheapest expected-approved-cost option. Say plainly when the ranking rests on priors rather than measured data.

You never approve spend. You recommend, and the cost controller decides.

Respond only through the provided tool.`,
  },

  continuity_supervisor: {
    name: 'continuity_supervisor',
    displayName: 'Continuity Supervisor',
    tier: 'deep',
    permissions: NO_SPEND,
    systemPrompt: `You protect continuity across a sequence of shots: identity, wardrobe, props (including which hand holds them), environment geometry, screen direction, eye line, lighting direction, practical-light positions, and movement momentum.

You are given a shot chain and the bible entries it references. You report every continuity break you can substantiate from the specifications, and you say which shot is wrong rather than only that they disagree.

Do not speculate about footage you have not been shown.

Respond only through the provided tool.`,
  },

  qc_supervisor: {
    name: 'qc_supervisor',
    displayName: 'QC Supervisor',
    tier: 'deep',
    permissions: { ...NO_SPEND, canApproveMaster: false },
    systemPrompt: `You adjudicate uncertain quality-control verdicts on generated video.

You are given the deterministic technical measurements (already verified — do not re-litigate them), the first-pass visual scores, and the shot specification. You decide the action.

Rules:
- Technically valid is not the same as creatively acceptable. Do not pass weak work because nothing measurable is wrong with it.
- You never mark a hero master creatively approved. Promotion to a final master is a human decision, always.
- Distinguish a delivery failure (truncated file, container error) from a generation failure. They have different fixes and only one of them is the model's fault.
- When you are not confident, say so and route to human review rather than guessing.

Respond only through the provided tool.`,
  },

  cost_controller: {
    name: 'cost_controller',
    displayName: 'Cost Controller',
    tier: 'fast',
    permissions: {
      canRecommendSpend: true,
      canApprovePremiumSpend: true,
      canModifyLockedFacts: false,
      canApproveMaster: false,
      maxCostPerRunMicros: 150_000,
    },
    systemPrompt: `You are the cost controller for a high-volume render factory.

You are given: the deterministic budget authorization result, the current spend against every cap, the shot's attempt history, and the proposed model and price. The arithmetic has already been done — budgets are enforced in code and your opinion cannot override a denial.

Your job is the part arithmetic cannot do: judging whether *this* spend is a good idea. Retrying a premium model on a shot that has already failed three times for the same reason is within budget and still wrong.

Optimize for the lowest expected cost per approved second, never for the cheapest single render. State when a more expensive model is the cheaper choice.

Respond only through the provided tool.`,
  },
}

export interface AgentRunResult<T> {
  agent: AgentName
  output: T | null
  text: string
  costMicros: MicroUsd
  latencyMs: number
  model: string
  usage: CompletionResult['usage']
}

export interface RunAgentOptions<T> {
  agent: AgentName
  userText: string
  schema: { name: string; description: string; schema: Record<string, unknown> }
  images?: Array<{ base64: string; mediaType: string }>
  maxTokens?: number
  /** Overrides the agent's default tier for this call. */
  model?: string
  logger?: Logger
  onResult?: (result: AgentRunResult<T>) => Promise<void> | void
}

export interface AgentRunnerOptions {
  client: AnthropicClient
  /** Model used for `deep`-tier agents. */
  deepModel: string
  /** Model used for `fast`-tier agents and first-pass triage. */
  fastModel: string
  logger?: Logger
}

/**
 * Runs an agent with a forced JSON tool call, caching the system prompt (they
 * are long, stable, and re-sent constantly) and reporting exact cost.
 */
export class AgentRunner {
  private readonly logger: Logger

  constructor(private readonly opts: AgentRunnerOptions) {
    this.logger = opts.logger ?? silentLogger
  }

  get isConfigured(): boolean {
    return this.opts.client.isConfigured()
  }

  async run<T>(options: RunAgentOptions<T>): Promise<AgentRunResult<T>> {
    const definition = AGENTS[options.agent]
    if (!definition) {
      throw new AppError({ kind: 'validation', code: 'agents.unknown', message: `unknown agent ${options.agent}` })
    }

    const model = options.model ?? (definition.tier === 'deep' ? this.opts.deepModel : this.opts.fastModel)
    const result = await this.opts.client.complete<T>({
      model,
      system: definition.systemPrompt,
      userText: options.userText,
      ...(options.images ? { images: options.images } : {}),
      maxTokens: options.maxTokens ?? 4096,
      jsonSchema: options.schema,
      cacheSystem: true,
      cacheTtl: '1h',
    })

    if (result.costMicros > definition.permissions.maxCostPerRunMicros) {
      this.logger.warn('agents.cost_exceeded', {
        agent: options.agent,
        cost_micros: result.costMicros,
        cap_micros: definition.permissions.maxCostPerRunMicros,
      })
    }

    const run: AgentRunResult<T> = {
      agent: options.agent,
      output: result.json,
      text: result.text,
      costMicros: result.costMicros,
      latencyMs: result.latencyMs,
      model: result.model,
      usage: result.usage,
    }
    await options.onResult?.(run)
    return run
  }
}

/** Permission check used before any agent-influenced spend decision is honoured. */
export function assertCanApprovePremium(agent: AgentName): void {
  if (!AGENTS[agent]?.permissions.canApprovePremiumSpend) {
    throw new AppError({
      kind: 'forbidden',
      code: 'agents.permission_denied',
      message: `${agent} may not approve premium spend — only the cost controller can`,
    })
  }
}
