import os from "node:os"
import path from "node:path"
import { createHash, randomUUID } from "node:crypto"
import { promises as fs } from "node:fs"
import * as z from "zod/v4"

const PLUGIN_ID = "observational-memory"
const STATE_VERSION = 4
const LOCK_STALE_MS = 5 * 60 * 1000
const RECENT_USER_PROTECTION = 2
const DEFAULT_CONTEXT_LIMIT = 128000
const MAX_OBSERVATION_LINE_CHARS = 10_000
const MAX_OBSERVATION_LINES = 400
const MAX_CURSOR_HINT_CHARS = 256
const TOOL_DEFINITION_HINT_TTL_MS = 60_000

const OBSERVER_EXTRACTION_INSTRUCTIONS = `CRITICAL: DISTINGUISH USER ASSERTIONS FROM QUESTIONS

When the user TELLS you something, capture it as an assertion. When the user ASKS for something, capture it as a question or request.

TEMPORAL ANCHORING:
- Keep the message time at the start of each observation as (HH:MM)
- Add an end date only when the text references a relative past/future date that can be resolved
- Split multiple events into separate observations

PRESERVE DETAILS:
- Keep names, identifiers, code snippets, numbers, file paths, errors, measurements, constraints, and decisions
- Preserve assistant explanations and tool findings when they matter for future continuity
- Group repeated similar actions under one parent observation with indented sub-bullets for distinct findings

AVOID REPETITION:
- Do not restate observations that already exist in Previous observations
- Only add a new observation when there is new information

CURRENT TASK / RESPONSE:
- <current-task> should state the immediate primary task and any secondary task that is waiting for user input
- <suggested-response> should hint at the assistant's immediate next reply or next tool action`

const OBSERVER_OUTPUT_FORMAT = `Use priority levels:
- 🔴 High: user facts, explicit requests, critical decisions, task completion
- 🟡 Medium: tool findings, project details, learned context
- 🟢 Low: minor or uncertain detail

Group observations by date, then use 24-hour times:

<observations>
Date: Dec 4, 2025
* 🔴 (14:30) User prefers direct answers
* 🟡 (14:31) Agent inspected src/auth.ts and found a missing null check
  * -> viewed src/auth.ts:45-60
  * -> identified a crash when token payload is missing
</observations>

<current-task>
Primary: Explain the auth fix and why it failed before.
Secondary: Wait for user confirmation before changing API behavior.
</current-task>

<suggested-response>
I found the null check that was missing in auth.ts. I’ll explain the failure mode and the fix next.
</suggested-response>`

const REFLECTOR_INSTRUCTIONS = `You are rewriting the assistant's durable observational memory.

IMPORTANT:
- Your reflection becomes the ENTIRE durable memory for earlier context
- Preserve dates, times, names, numbers, decisions, user assertions, key code details, and recent context
- Compress older observations more aggressively than recent ones
- Merge repeated tool activity into concise outcome-focused lines
- Keep the same date-grouped observation format with priority emojis
- Update <current-task> and <suggested-response> only when you have a better current summary`

type BufferKind = "user" | "assistant" | "tool"
type MaintenanceToolID = "om_observe" | "om_reflect"

type BufferItem = {
  kind: BufferKind
  id: string
  turnAnchorMessageID: string
  atMs: number
  text: string
  tokenEstimate: number
}

type OmStateV4 = {
  version: 4
  sessionID: string
  writerInstanceID: string
  generation: number
  lastObserved: {
    turnAnchorMessageID?: string
    atMs?: number
  }
  buffer: {
    items: BufferItem[]
    tokenEstimateTotal: number
  }
  memory: {
    observations: string
    currentTask?: string
    suggestedResponse?: string
    tokenEstimate: number
    updatedAtMs: number
  }
  stats: {
    totalObservedItems: number
    totalReflections: number
    observeFailures: number
    reflectFailures: number
    maintenanceDeferredTurns: number
    recoveryCaptures: number
  }
  flags: {
    observeRequired?: boolean
    reflectRequired?: boolean
    maintenanceDeferred?: boolean
    lockContention?: boolean
  }
  runtime: {
    currentTurnAnchorMessageID?: string
    continuationHint?: boolean
    lastPrunedMessageID?: string
    maintenancePromptIssued?: boolean
    pendingMaintenanceTool?: MaintenanceToolID
    observeCursorHint?: string
  }
}

type OmConfig = {
  enabled: boolean
  mode: "llm" | "deterministic"
  observeThresholdTokens?: number
  reflectThresholdTokens?: number
  rawMessageBudgetTokens?: number
  toolOutputChars: number
  stateDir?: string
  maxObserveInputChars: number
  maxObservationsChars: number
  maxTaskChars: number
  maxSuggestedResponseChars: number
}

type Thresholds = {
  observationThresholdTokens: number
  reflectionThresholdTokens: number
  rawMessageBudgetTokens: number
  observeHardOverdue: number
  reflectHardOverdue: number
}

type RuntimeStatus = {
  shouldInject: boolean
  shouldPrune: boolean
  continuationHint: boolean
  requiredTool?: MaintenanceToolID
}

type ObserveInput = {
  formatted: string
  lastIncludedAnchor?: string
  anchorCount: number
  itemCount: number
  tokenEstimate: number
}

type SanitizedObserveArgs = {
  observations: string
  currentTask?: string
  suggestedResponse?: string
  confirmObservedThrough?: string
}

type SanitizedReflectArgs = {
  observations: string
  currentTask?: string
  suggestedResponse?: string
  hasCurrentTask: boolean
  hasSuggestedResponse: boolean
  compressionLevel?: 0 | 1 | 2 | 3
}

type ObservationGroup = {
  header?: string
  lines: string[]
}

const cache = new Map<string, OmStateV4>()
const runtimeStatus = new Map<string, RuntimeStatus>()
const configCache = new Map<string, Promise<OmConfig>>()
const writerInstanceID = randomUUID()
let toolDefinitionHint: { toolID: MaintenanceToolID; expiresAtMs: number } | undefined

function defineTool<Args extends z.ZodRawShape>(input: {
  description: string
  args: Args
  execute: (
    args: z.infer<z.ZodObject<Args>>,
    context: { sessionID: string; metadata: (input: { title?: string; metadata?: Record<string, unknown> }) => void },
  ) => Promise<string>
}) {
  return input
}

export const ObservationalMemoryPlugin = async ({
  client,
  directory,
  project,
}: {
  client: {
    app: {
      log: (options: {
        body: { service: string; level: "debug" | "info" | "warn" | "error"; message: string; extra?: Record<string, unknown> }
      }) => Promise<unknown>
    }
    session: {
      message: (options: { sessionID: string; messageID: string }) => Promise<{ data?: { parts: Array<{ type?: string; text?: string; synthetic?: boolean; ignored?: boolean }> } | null }>
    }
  }
  directory: string
  project: { id: string; worktree: string }
}) => {
  await log(client, "info", "Plugin initialized", {
    projectID: project.id,
    directory,
  })

  return {
    tool: {
      om_observe: defineTool({
        description:
          "Record structured observational memory. Use this before answering when the system requires observation maintenance.",
        args: {
          observations: z.string(),
          currentTask: z.string().optional(),
          suggestedResponse: z.string().optional(),
          confirmObservedThrough: z.string().optional(),
        },
        async execute(args, context) {
          context.metadata({ title: "Recording observations..." })
          const state = await withState(
            context.sessionID,
            directory,
            async (current, cfg) => applyObserveToolResult(current, cfg, args),
            async () => {
              context.metadata({
                title: "Observational memory passive",
                metadata: { reason: "lock-contention" },
              })
            },
          )
          return JSON.stringify(statusPayload(state, await getConfig(directory)), null, 2)
        },
      }),
      om_reflect: defineTool({
        description:
          "Rewrite and compress durable observational memory. Use this before answering when the system requires reflection maintenance.",
        args: {
          observations: z.string(),
          currentTask: z.string().optional(),
          suggestedResponse: z.string().optional(),
          compressionLevel: z.union([z.literal(0), z.literal(1), z.literal(2), z.literal(3)]).optional(),
        },
        async execute(args, context) {
          context.metadata({ title: "Compressing observations..." })
          const state = await withState(
            context.sessionID,
            directory,
            async (current, cfg) => applyReflectToolResult(current, cfg, args),
            async () => {
              context.metadata({
                title: "Observational memory passive",
                metadata: { reason: "lock-contention" },
              })
            },
          )
          return JSON.stringify(statusPayload(state, await getConfig(directory)), null, 2)
        },
      }),
      om_status: defineTool({
        description: "Show observational memory status, thresholds, maintenance requirements, and current estimates for this session.",
        args: {},
        async execute(_args, context) {
          const { status } = await readOmStatus(context.sessionID, directory)
          return JSON.stringify(status, null, 2)
        },
      }),
      om_export: defineTool({
        description: "Export the full observational memory state for this session.",
        args: {},
        async execute(_args, context) {
          const state = await loadState(context.sessionID, directory)
          return JSON.stringify(state, null, 2)
        },
      }),
      om_forget: defineTool({
        description: "Clear observational memory state for this session.",
        args: {
          confirm: z.boolean().optional(),
        },
        async execute(args, context) {
          if (!args.confirm) {
            return "Set confirm=true to clear observational memory for this session."
          }
          await forgetState(context.sessionID, directory)
          return "Observational memory cleared for this session."
        },
      }),
    },
    "tool.definition": async (input, output) => {
      if (!toolDefinitionHint) return
      if (Date.now() > toolDefinitionHint.expiresAtMs) {
        toolDefinitionHint = undefined
        return
      }
      if (input.toolID !== toolDefinitionHint.toolID) return
      output.description = `${output.description} REQUIRED THIS TURN when the system asks for observational-memory maintenance. Call this tool before answering.`
    },
    "chat.message": async (input, output) => {
      if (!input.sessionID || !output.message?.id) return
      const text = extractUserText(output.parts)
      if (!text) return
      await withState(input.sessionID, directory, async (state) => {
        state.runtime.currentTurnAnchorMessageID = output.message.id
        appendBufferItem(state, {
          kind: "user",
          id: output.message.id,
          turnAnchorMessageID: output.message.id,
          atMs: Date.now(),
          text,
          tokenEstimate: estimateTokens(text),
        })
        state.flags.maintenanceDeferred = false
        state.runtime.continuationHint = false
        return state
      })
    },
    "tool.execute.after": async (input, output) => {
      if (!input.sessionID) return
      if (isOmTool(input.tool)) return
      const content = normalizeText(output.output)
      if (!content) return
      await withState(input.sessionID, directory, async (state, cfg) => {
        const anchor = state.runtime.currentTurnAnchorMessageID
        if (!anchor) return state
        const text = truncateText(content, cfg.toolOutputChars)
        appendBufferItem(state, {
          kind: "tool",
          id: `${input.callID}:${hashText(text)}`,
          turnAnchorMessageID: anchor,
          atMs: Date.now(),
          text: `${input.tool}: ${text}`,
          tokenEstimate: estimateTokens(text),
        })
        return state
      })
    },
    event: async ({ event }) => {
      if (event.type === "message.updated") {
        const info = event.properties.info
        if (info.role !== "assistant") return
        if (!info.time.completed) return
        if (info.summary) return
        const response = await client.session.message({
          sessionID: info.sessionID,
          messageID: info.id,
        })
        const message = response.data
        if (!message) return
        const text = extractAssistantText(message.parts)
        if (!text) return
        await withState(info.sessionID, directory, async (state) => {
          if (state.buffer.items.some((item) => item.kind === "assistant" && item.id === info.id)) {
            return state
          }
          appendBufferItem(state, {
            kind: "assistant",
            id: info.id,
            turnAnchorMessageID: info.parentID,
            atMs: info.time.completed ?? Date.now(),
            text,
            tokenEstimate: estimateTokens(text),
          })
          return state
        })
        return
      }

      if (event.type === "session.compacted") {
        await withState(event.properties.sessionID, directory, async (state) => {
          state.buffer.items = []
          state.buffer.tokenEstimateTotal = 0
          state.lastObserved = {}
          state.memory = emptyMemory()
          state.runtime = {}
          state.flags = {}
          return state
        })
        await log(client, "info", "Compaction boundary reset observational memory", {
          sessionID: event.properties.sessionID,
        })
      }
    },
    "experimental.chat.messages.transform": async (_input, output) => {
      const sessionID = getSessionIDFromMessages(output.messages)
      if (!sessionID) return
      const config = await getConfig(directory)
      if (!config.enabled) return
      const state = await loadState(sessionID, directory)
      const thresholds = resolveThresholds(config, DEFAULT_CONTEXT_LIMIT)
      evaluateFlags(state, thresholds)
      const requiredTool = selectMaintenanceTool(state)
      const prune = pruneMessages(output.messages, state, thresholds, requiredTool)
      runtimeStatus.set(sessionID, {
        shouldInject: prune.shouldInject,
        shouldPrune: prune.pruned,
        continuationHint: prune.continuationHint,
        requiredTool,
      })
      if (prune.pruned) {
        output.messages.splice(0, output.messages.length, ...prune.messages)
      }
    },
    "experimental.chat.system.transform": async (input, output) => {
      if (!input.sessionID) return
      const config = await getConfig(directory)
      if (!config.enabled) return
      const thresholds = resolveThresholds(config, input.model.limit.context)
      const ready = await ensureMemoryReady(input.sessionID, directory, config, thresholds, async (message, extra) => {
        await log(client, "info", message, {
          sessionID: input.sessionID,
          modelID: input.model.id,
          ...extra,
        })
      })

      const runtime = runtimeStatus.get(input.sessionID) ?? {
        shouldInject: false,
        shouldPrune: false,
        continuationHint: false,
      }

      const requiredTool = selectMaintenanceTool(ready)
      if (requiredTool === "om_observe") {
        output.system.push(renderObserveMaintenanceBlock(ready, config))
        runtime.shouldInject = false
      } else if (requiredTool === "om_reflect") {
        output.system.push(renderReflectMaintenanceBlock(ready))
        runtime.shouldInject = false
      } else if (ready.memory.observations && !ready.flags.lockContention) {
        output.system.push(renderOmBlock(ready.memory))
        runtime.shouldInject = true
      } else if ((ready.memory.currentTask || ready.memory.suggestedResponse) && !ready.flags.lockContention) {
        output.system.push(renderTaskHints(ready.memory))
      }

      if (requiredTool && (ready.memory.currentTask || ready.memory.suggestedResponse)) {
        output.system.push(renderTaskHints(ready.memory))
      }

      if (runtime.continuationHint) {
        output.system.push(renderContinuationHint())
      }
      if (ready.flags.maintenanceDeferred && runtime.shouldInject === false) {
        output.system.push(
          "<system-reminder>Earlier context could not be refreshed this turn. Prefer the visible recent transcript.</system-reminder>",
        )
      }

      runtime.requiredTool = requiredTool
      runtimeStatus.set(input.sessionID, runtime)
    },
  }
}

function createEmptyState(sessionID: string): OmStateV4 {
  return {
    version: STATE_VERSION,
    sessionID,
    writerInstanceID,
    generation: 0,
    lastObserved: {},
    buffer: {
      items: [],
      tokenEstimateTotal: 0,
    },
    memory: emptyMemory(),
    stats: {
      totalObservedItems: 0,
      totalReflections: 0,
      observeFailures: 0,
      reflectFailures: 0,
      maintenanceDeferredTurns: 0,
      recoveryCaptures: 0,
    },
    flags: {},
    runtime: {},
  }
}

function migrateState(sessionID: string, parsed: unknown): OmStateV4 {
  const legacy = parsed as Partial<OmStateV4> & {
    version?: number
    lastObserved?: OmStateV4["lastObserved"]
    buffer?: OmStateV4["buffer"]
    memory?: OmStateV4["memory"]
    stats?: Partial<OmStateV4["stats"]>
    flags?: OmStateV4["flags"]
    runtime?: Partial<OmStateV4["runtime"]>
  }
  if (legacy.version === STATE_VERSION) {
    return {
      ...createEmptyState(sessionID),
      ...legacy,
      version: STATE_VERSION,
      sessionID,
      stats: {
        ...createEmptyState(sessionID).stats,
        ...legacy.stats,
      },
      runtime: {
        ...legacy.runtime,
      },
    }
  }
  if (legacy.version === 3) {
    return {
      ...createEmptyState(sessionID),
      sessionID,
      writerInstanceID: legacy.writerInstanceID ?? writerInstanceID,
      generation: legacy.generation ?? 0,
      lastObserved: legacy.lastObserved ?? {},
      buffer: legacy.buffer ?? { items: [], tokenEstimateTotal: 0 },
      memory: legacy.memory ?? emptyMemory(),
      stats: {
        ...createEmptyState(sessionID).stats,
        ...legacy.stats,
      },
      flags: legacy.flags ?? {},
      runtime: {
        ...legacy.runtime,
      },
    }
  }
  return createEmptyState(sessionID)
}

function emptyMemory() {
  return {
    observations: "",
    currentTask: undefined,
    suggestedResponse: undefined,
    tokenEstimate: 0,
    updatedAtMs: 0,
  }
}

function estimateTokens(text: string) {
  return Math.ceil(text.length / 4)
}

function normalizeText(text: string | undefined) {
  return (text ?? "").replace(/\s+/g, " ").trim()
}

function truncateText(text: string, maxChars: number) {
  if (text.length <= maxChars) return text
  return `${text.slice(0, Math.max(0, maxChars - 3)).trimEnd()}...`
}

function hashText(text: string) {
  return createHash("sha1").update(text).digest("hex").slice(0, 12)
}

function extractUserText(parts: Array<{ type?: string; text?: string; synthetic?: boolean; ignored?: boolean }>) {
  return normalizeText(
    parts
      .filter((part) => part.type === "text" && !part.synthetic && !part.ignored)
      .map((part) => part.text ?? "")
      .join("\n"),
  )
}

function extractAssistantText(parts: Array<{ type?: string; text?: string; synthetic?: boolean; ignored?: boolean }>) {
  return normalizeText(
    parts
      .filter((part) => part.type === "text" && !part.synthetic && !part.ignored)
      .map((part) => part.text ?? "")
      .join("\n"),
  )
}

function isOmTool(toolID: string) {
  return toolID === "om_observe" || toolID === "om_reflect" || toolID === "om_status" || toolID === "om_export" || toolID === "om_forget"
}

function appendBufferItem(state: OmStateV4, item: BufferItem) {
  if (!item.text) return
  if (state.buffer.items.some((existing) => existing.kind === item.kind && existing.id === item.id)) return
  state.buffer.items.push(item)
  state.buffer.items.sort((a, b) => a.atMs - b.atMs)
  state.buffer.tokenEstimateTotal = state.buffer.items.reduce((total, entry) => total + entry.tokenEstimate, 0)
}

async function ensureMemoryReady(
  sessionID: string,
  directory: string,
  config: OmConfig,
  thresholds: Thresholds,
  report: (message: string, extra?: Record<string, unknown>) => Promise<void>,
) {
  return withState(
    sessionID,
    directory,
    async (state) => {
      evaluateFlags(state, thresholds)
      const requiredTool = selectMaintenanceTool(state)

      if (config.mode === "deterministic") {
        if (requiredTool === "om_observe") {
          await report("Context limit reached. Observing recent history...", {
            observableBufferTokens: observableBufferTokenTotal(state),
          })
          state = runDeterministicObserve(state, config, thresholds, { force: true })
          evaluateFlags(state, thresholds)
        }
        if (!state.flags.observeRequired && state.flags.reflectRequired) {
          await report("Compressing memory before continuing...", {
            memoryTokens: state.memory.tokenEstimate,
          })
          state = runDeterministicReflect(state, { force: true })
          evaluateFlags(state, thresholds)
        }
        if (state.flags.observeRequired || state.flags.reflectRequired) {
          state.flags.maintenanceDeferred = true
          state.stats.maintenanceDeferredTurns += 1
          await report("Memory maintenance deferred. Continuing with raw context.", {
            observeRequired: state.flags.observeRequired,
            reflectRequired: state.flags.reflectRequired,
            mode: config.mode,
          })
        } else {
          state.flags.maintenanceDeferred = false
          state.runtime.maintenancePromptIssued = false
          state.runtime.pendingMaintenanceTool = undefined
          state.runtime.observeCursorHint = undefined
          setToolDefinitionHint(undefined)
        }
        return state
      }

      if (requiredTool === "om_observe") {
        const observeInput = buildObserveInput(state, config)
        state.runtime.observeCursorHint = observeInput.lastIncludedAnchor
        if (state.runtime.maintenancePromptIssued && state.runtime.pendingMaintenanceTool === "om_observe") {
          state.flags.maintenanceDeferred = true
          state.stats.maintenanceDeferredTurns += 1
        } else {
          state.flags.maintenanceDeferred = false
        }
        state.runtime.maintenancePromptIssued = true
        state.runtime.pendingMaintenanceTool = "om_observe"
        setToolDefinitionHint("om_observe")
        await report("Context limit reached. Observing recent history...", {
          observableBufferTokens: observableBufferTokenTotal(state),
          observeInputTokens: observeInput.tokenEstimate,
          observeInputAnchors: observeInput.anchorCount,
          mode: config.mode,
        })
        return state
      }

      state.runtime.observeCursorHint = undefined

      if (requiredTool === "om_reflect") {
        if (state.runtime.maintenancePromptIssued && state.runtime.pendingMaintenanceTool === "om_reflect") {
          state.flags.maintenanceDeferred = true
          state.stats.maintenanceDeferredTurns += 1
        } else {
          state.flags.maintenanceDeferred = false
        }
        state.runtime.maintenancePromptIssued = true
        state.runtime.pendingMaintenanceTool = "om_reflect"
        setToolDefinitionHint("om_reflect")
        await report("Compressing memory before continuing...", {
          memoryTokens: state.memory.tokenEstimate,
          mode: config.mode,
        })
        return state
      }

      state.flags.maintenanceDeferred = false
      state.runtime.maintenancePromptIssued = false
      state.runtime.pendingMaintenanceTool = undefined
      state.runtime.observeCursorHint = undefined
      setToolDefinitionHint(undefined)
      return state
    },
    async () => {
      await report("Observational memory is in passive mode because another process owns this session.", {
        lockContention: true,
      })
    },
  )
}

function runDeterministicObserve(state: OmStateV4, config: OmConfig, thresholds: Thresholds, options: { force: boolean }) {
  const completedAnchors = orderedCompletedAnchorIDs(state.buffer.items)
  if (!completedAnchors.length && !options.force) {
    state.flags.observeRequired = false
    return state
  }
  const observedItems = state.buffer.items.filter((item) => completedAnchors.includes(item.turnAnchorMessageID))
  if (!observedItems.length) {
    state.flags.observeRequired = false
    return state
  }

  const grouped = groupBufferItemsByAnchor(observedItems)
  const chunks = Array.from(grouped.entries())
    .map(([anchor, items]) => summarizeObservedTurn(anchor, items, config.toolOutputChars))
    .filter(Boolean)

  const merged = mergeObservationTexts(state.memory.observations, chunks.join("\n"), config, thresholds)
  const currentTask = inferCurrentTask(state, config.maxTaskChars)

  state.memory.observations = merged
  state.memory.currentTask = currentTask || undefined
  state.memory.suggestedResponse = undefined
  state.memory.tokenEstimate = estimateTokens(renderMemoryForTokens(state.memory))
  state.memory.updatedAtMs = Date.now()
  state.lastObserved.turnAnchorMessageID = completedAnchors.at(-1)
  state.lastObserved.atMs = observedItems[observedItems.length - 1]?.atMs
  state.stats.totalObservedItems += observedItems.length
  state.buffer.items = state.buffer.items.filter((item) => !completedAnchors.includes(item.turnAnchorMessageID))
  state.buffer.tokenEstimateTotal = state.buffer.items.reduce((total, item) => total + item.tokenEstimate, 0)
  state.flags.observeRequired = false
  state.runtime.observeCursorHint = undefined
  return state
}

function runDeterministicReflect(state: OmStateV4, options: { force: boolean }) {
  if (!state.memory.observations && !options.force) {
    state.flags.reflectRequired = false
    return state
  }
  const lines = sanitizeObservationText(state.memory.observations, Number.MAX_SAFE_INTEGER)
    .split("\n")
    .filter(Boolean)
  const compacted = dedupeLines(lines).slice(-12)
  state.memory.observations = compacted.join("\n")
  state.memory.tokenEstimate = estimateTokens(renderMemoryForTokens(state.memory))
  state.memory.updatedAtMs = Date.now()
  state.stats.totalReflections += 1
  state.flags.reflectRequired = false
  return state
}

function applyObserveToolResult(
  state: OmStateV4,
  config: OmConfig,
  args: { observations: string; currentTask?: string; suggestedResponse?: string; confirmObservedThrough?: string },
) {
  const thresholds = resolveThresholds(config, DEFAULT_CONTEXT_LIMIT)
  evaluateFlags(state, thresholds)
  const requiredTool = selectMaintenanceTool(state)
  if (config.mode === "llm" && requiredTool && requiredTool !== "om_observe") {
    state.stats.observeFailures += 1
    state.flags.maintenanceDeferred = true
    return state
  }

  const sanitized = sanitizeObserveArgs(args, config)
  if (!sanitized.observations || detectDegenerateRepetition(sanitized.observations) || !hasMeaningfulObservationContent(sanitized.observations)) {
    state.stats.observeFailures += 1
    state.flags.maintenanceDeferred = true
    return state
  }

  const completedAnchors = orderedCompletedAnchorIDs(state.buffer.items)
  if (!completedAnchors.length) {
    state.flags.observeRequired = false
    state.flags.maintenanceDeferred = false
    state.runtime.maintenancePromptIssued = false
    state.runtime.pendingMaintenanceTool = undefined
    state.runtime.observeCursorHint = undefined
    return state
  }

  const confirmObservedThrough =
    sanitized.confirmObservedThrough || state.runtime.observeCursorHint
      ? truncateText((sanitized.confirmObservedThrough || state.runtime.observeCursorHint || "").trim(), MAX_CURSOR_HINT_CHARS)
      : undefined

  const finalAnchor =
    confirmObservedThrough && completedAnchors.includes(confirmObservedThrough)
      ? confirmObservedThrough
      : state.runtime.observeCursorHint && completedAnchors.includes(state.runtime.observeCursorHint)
        ? state.runtime.observeCursorHint
        : completedAnchors.at(-1)

  const lastAnchorIndex = finalAnchor ? completedAnchors.indexOf(finalAnchor) : completedAnchors.length - 1
  const anchorsToApply = completedAnchors.slice(0, lastAnchorIndex + 1)
  const observedItems = state.buffer.items.filter((item) => anchorsToApply.includes(item.turnAnchorMessageID))
  if (!observedItems.length) {
    state.stats.observeFailures += 1
    state.flags.maintenanceDeferred = true
    return state
  }

  state.memory.observations = mergeObservationTexts(state.memory.observations, sanitized.observations, config, thresholds)
  state.memory.currentTask = sanitized.currentTask
  state.memory.suggestedResponse = sanitized.suggestedResponse
  state.memory.tokenEstimate = estimateTokens(renderMemoryForTokens(state.memory))
  state.memory.updatedAtMs = Date.now()
  state.lastObserved.turnAnchorMessageID = anchorsToApply.at(-1)
  state.lastObserved.atMs = observedItems[observedItems.length - 1]?.atMs
  state.stats.totalObservedItems += observedItems.length
  state.buffer.items = state.buffer.items.filter((item) => !anchorsToApply.includes(item.turnAnchorMessageID))
  state.buffer.tokenEstimateTotal = state.buffer.items.reduce((total, item) => total + item.tokenEstimate, 0)
  state.flags.observeRequired = false
  state.flags.maintenanceDeferred = false
  state.runtime.maintenancePromptIssued = false
  state.runtime.pendingMaintenanceTool = undefined
  state.runtime.observeCursorHint = undefined
  setToolDefinitionHint(undefined)
  evaluateFlags(state, thresholds)
  return state
}

function applyReflectToolResult(
  state: OmStateV4,
  config: OmConfig,
  args: { observations: string; currentTask?: string; suggestedResponse?: string; compressionLevel?: 0 | 1 | 2 | 3 },
) {
  const thresholds = resolveThresholds(config, DEFAULT_CONTEXT_LIMIT)
  evaluateFlags(state, thresholds)
  const requiredTool = selectMaintenanceTool(state)
  if (config.mode === "llm" && requiredTool && requiredTool !== "om_reflect") {
    state.stats.reflectFailures += 1
    state.flags.maintenanceDeferred = true
    return state
  }

  const sanitized = sanitizeReflectArgs(args, config)
  if (!sanitized.observations || detectDegenerateRepetition(sanitized.observations) || !hasMeaningfulObservationContent(sanitized.observations)) {
    state.stats.reflectFailures += 1
    state.flags.maintenanceDeferred = true
    return state
  }

  state.memory.observations = trimObservationGroups(sanitizeObservationText(sanitized.observations, config.maxObservationsChars), config, thresholds)
  if (sanitized.hasCurrentTask) {
    state.memory.currentTask = sanitized.currentTask
  }
  if (sanitized.hasSuggestedResponse) {
    state.memory.suggestedResponse = sanitized.suggestedResponse
  }
  state.memory.tokenEstimate = estimateTokens(renderMemoryForTokens(state.memory))
  state.memory.updatedAtMs = Date.now()
  state.stats.totalReflections += 1
  state.flags.reflectRequired = false
  state.flags.maintenanceDeferred = false
  state.runtime.maintenancePromptIssued = false
  state.runtime.pendingMaintenanceTool = undefined
  state.runtime.observeCursorHint = undefined
  setToolDefinitionHint(undefined)
  evaluateFlags(state, thresholds)
  return state
}

function summarizeObservedTurn(anchor: string, items: BufferItem[], toolOutputChars: number) {
  const user = items.find((item) => item.kind === "user")
  const assistant = items.findLast((item) => item.kind === "assistant")
  const tools = items.filter((item) => item.kind === "tool")
  const lines: string[] = []
  if (user?.text) {
    lines.push(`- User asked: ${truncateText(user.text, 180)}`)
  }
  if (tools.length) {
    const toolLine = tools
      .slice(-2)
      .map((item) => truncateText(item.text.replace(/^.*?:\s*/, ""), Math.min(toolOutputChars, 160)))
      .join(" | ")
    if (toolLine) {
      lines.push(`- Tool results: ${toolLine}`)
    }
  }
  if (assistant?.text) {
    lines.push(`- Assistant did: ${truncateText(assistant.text, 180)}`)
  }
  if (!lines.length) return ""
  return [`Turn ${anchor}:`, ...lines].join(" ")
}

function inferCurrentTask(state: OmStateV4, maxChars: number) {
  const pendingUser = [...state.buffer.items].reverse().find((item) => item.kind === "user")
  if (pendingUser) return truncateText(pendingUser.text, maxChars)
  const lastObservation = state.memory.observations.split("\n").filter(Boolean).at(-1)
  return lastObservation ? truncateText(lastObservation, maxChars) : ""
}

function dedupeLines(lines: string[]) {
  const seen = new Set<string>()
  const ordered: string[] = []
  for (const line of lines) {
    if (!line) continue
    if (seen.has(line)) continue
    seen.add(line)
    ordered.push(line)
  }
  return ordered
}

function completedAnchorIDs(items: BufferItem[]) {
  const anchors = new Set<string>()
  for (const item of items) {
    if (item.kind === "assistant") anchors.add(item.turnAnchorMessageID)
  }
  return anchors
}

function orderedCompletedAnchorIDs(items: BufferItem[]) {
  const completed = completedAnchorIDs(items)
  const ordered: string[] = []
  for (const item of items) {
    if (!completed.has(item.turnAnchorMessageID)) continue
    if (ordered.includes(item.turnAnchorMessageID)) continue
    ordered.push(item.turnAnchorMessageID)
  }
  return ordered
}

function observableBufferItems(items: BufferItem[]) {
  const completed = completedAnchorIDs(items)
  return items.filter((item) => completed.has(item.turnAnchorMessageID))
}

function observableBufferTokenTotal(state: OmStateV4) {
  return observableBufferItems(state.buffer.items).reduce((total, item) => total + item.tokenEstimate, 0)
}

function evaluateFlags(state: OmStateV4, thresholds: Thresholds) {
  state.flags.observeRequired = observableBufferTokenTotal(state) >= thresholds.observationThresholdTokens
  state.flags.reflectRequired = state.memory.tokenEstimate >= thresholds.reflectionThresholdTokens
}

function selectMaintenanceTool(state: OmStateV4): MaintenanceToolID | undefined {
  if (state.flags.observeRequired) return "om_observe"
  if (state.flags.reflectRequired) return "om_reflect"
  return undefined
}

function renderOmBlock(memory: OmStateV4["memory"]) {
  const parts = ["<observations>", escapeXml(memory.observations || "No durable observations yet."), "</observations>"]
  if (memory.currentTask) {
    parts.push("<current-task>", escapeXml(memory.currentTask), "</current-task>")
  }
  if (memory.suggestedResponse) {
    parts.push("<suggested-response>", escapeXml(memory.suggestedResponse), "</suggested-response>")
  }
  parts.push(
    "<system-reminder>Observations are authoritative for pruned earlier context. Use the newest observation when conflicts exist. Do not mention the memory system to the user.</system-reminder>",
  )
  return parts.join("\n")
}

function renderTaskHints(memory: OmStateV4["memory"]) {
  const parts: string[] = []
  if (memory.currentTask) {
    parts.push("<current-task>", escapeXml(memory.currentTask), "</current-task>")
  }
  if (memory.suggestedResponse) {
    parts.push("<suggested-response>", escapeXml(memory.suggestedResponse), "</suggested-response>")
  }
  return parts.join("\n")
}

function renderObserveMaintenanceBlock(state: OmStateV4, config: OmConfig) {
  const observeInput = buildObserveInput(state, config)
  const previousObservations = state.memory.observations || "None."
  const cursorHint = observeInput.lastIncludedAnchor
    ? `Set confirmObservedThrough to "${observeInput.lastIncludedAnchor}" unless you intentionally observed an earlier completed turn boundary.`
    : "confirmObservedThrough is optional."

  return [
    "<system-reminder>",
    "Before answering, call om_observe exactly once.",
    "Return structured tool arguments only. Do not answer the user before the tool call.",
    "</system-reminder>",
    "<observer-instructions>",
    OBSERVER_EXTRACTION_INSTRUCTIONS,
    "",
    OBSERVER_OUTPUT_FORMAT,
    "",
    "Tool args:",
    '- observations: string containing only the <observations> content, without wrapper tags',
    '- currentTask: optional string containing only the <current-task> content',
    '- suggestedResponse: optional string containing only the <suggested-response> content',
    `- confirmObservedThrough: optional completed turn anchor cursor hint. ${cursorHint}`,
    "</observer-instructions>",
    "<previous-observations>",
    escapeXml(previousObservations),
    "</previous-observations>",
    "<new-history-to-observe>",
    escapeXml(observeInput.formatted || "No completed turn groups are ready to observe."),
    "</new-history-to-observe>",
  ].join("\n")
}

function renderReflectMaintenanceBlock(state: OmStateV4) {
  return [
    "<system-reminder>",
    "Before answering, call om_reflect exactly once.",
    "Return structured tool arguments only. Do not answer the user before the tool call.",
    "</system-reminder>",
    "<reflector-instructions>",
    REFLECTOR_INSTRUCTIONS,
    "",
    OBSERVER_OUTPUT_FORMAT,
    "",
    "Tool args:",
    '- observations: required replacement observations string without <observations> wrapper tags',
    "- currentTask: optional replacement current task",
    "- suggestedResponse: optional replacement suggested response",
    "- compressionLevel: optional retry level from 0 to 3",
    "</reflector-instructions>",
    "<observations-to-reflect>",
    escapeXml(state.memory.observations || "No durable observations yet."),
    "</observations-to-reflect>",
  ].join("\n")
}

function renderContinuationHint() {
  return [
    "<system-reminder>",
    "This is not a new conversation. Earlier context was compressed into observations.",
    "Continue naturally without referencing the memory system.",
    "</system-reminder>",
  ].join("\n")
}

function escapeXml(text: string) {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
}

function buildObserveInput(state: OmStateV4, config: OmConfig): ObserveInput {
  const groups = groupBufferItemsByAnchor(observableBufferItems(state.buffer.items))
  const sections: string[] = []
  let lastIncludedAnchor: string | undefined
  let itemCount = 0

  for (const [anchor, items] of groups.entries()) {
    const section = formatObservedTurnGroup(anchor, items)
    const next = sections.length ? `${sections.join("\n\n")}\n\n${section}` : section
    if (sections.length > 0 && next.length > config.maxObserveInputChars) {
      break
    }
    if (!sections.length && next.length > config.maxObserveInputChars) {
      sections.push(truncateText(section, config.maxObserveInputChars))
      lastIncludedAnchor = anchor
      itemCount += items.length
      break
    }
    sections.push(section)
    lastIncludedAnchor = anchor
    itemCount += items.length
  }

  const formatted = sections.join("\n\n")
  return {
    formatted,
    lastIncludedAnchor,
    anchorCount: sections.length,
    itemCount,
    tokenEstimate: estimateTokens(formatted),
  }
}

function groupBufferItemsByAnchor(items: BufferItem[]) {
  const grouped = new Map<string, BufferItem[]>()
  for (const item of items) {
    const existing = grouped.get(item.turnAnchorMessageID) ?? []
    existing.push(item)
    grouped.set(item.turnAnchorMessageID, existing)
  }
  return new Map(
    [...grouped.entries()]
      .map(([anchor, groupedItems]) => [anchor, groupedItems.toSorted((a, b) => a.atMs - b.atMs)] as const)
      .toSorted((a, b) => (a[1][0]?.atMs ?? 0) - (b[1][0]?.atMs ?? 0)),
  )
}

function formatObservedTurnGroup(anchor: string, items: BufferItem[]) {
  const firstAt = items[0]?.atMs ?? Date.now()
  const lines = [
    `Turn Anchor: ${anchor}`,
    `Date: ${formatLocalDate(firstAt)}`,
  ]

  for (const item of items) {
    lines.push(`${labelForBufferKind(item.kind)} (${formatLocalTime(item.atMs)}): ${item.text}`)
  }

  return lines.join("\n")
}

function labelForBufferKind(kind: BufferKind) {
  if (kind === "user") return "User"
  if (kind === "assistant") return "Assistant"
  return "Tool"
}

function formatLocalDate(atMs: number) {
  return new Date(atMs).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  })
}

function formatLocalTime(atMs: number) {
  return new Date(atMs).toLocaleTimeString("en-US", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  })
}

function parseObservationGroups(text: string) {
  const groups: ObservationGroup[] = []
  let current: ObservationGroup = { lines: [] }

  for (const rawLine of text.replace(/\r/g, "").split("\n")) {
    const line = rawLine.replace(/[ \t]+$/g, "")
    if (!line.trim()) continue
    if (/^Date:\s+/i.test(line)) {
      if (current.header || current.lines.length) groups.push(current)
      current = { header: line.trim(), lines: [] }
      continue
    }
    current.lines.push(line)
  }

  if (current.header || current.lines.length) groups.push(current)
  return groups
}

function mergeObservationTexts(existing: string, incoming: string, config: OmConfig, thresholds: Thresholds) {
  const order: string[] = []
  const merged = new Map<string, ObservationGroup>()

  for (const source of [existing, incoming]) {
    for (const group of parseObservationGroups(source)) {
      const key = group.header ? `date:${group.header}` : "ungrouped"
      if (!merged.has(key)) {
        merged.set(key, { header: group.header, lines: [] })
        order.push(key)
      }
      const target = merged.get(key)!
      const seen = new Set(target.lines)
      for (const line of group.lines) {
        if (seen.has(line)) continue
        seen.add(line)
        target.lines.push(line)
      }
    }
  }

  const text = renderObservationGroups(order.map((key) => merged.get(key)!).filter(Boolean))
  return trimObservationGroups(text, config, thresholds)
}

function renderObservationGroups(groups: ObservationGroup[]) {
  return groups
    .filter((group) => group.header || group.lines.length)
    .map((group) => {
      const lines = []
      if (group.header) lines.push(group.header)
      lines.push(...dedupeLines(group.lines))
      return lines.join("\n").trim()
    })
    .filter(Boolean)
    .join("\n")
    .trim()
}

function trimObservationGroups(text: string, config: OmConfig, thresholds: Thresholds) {
  const groups = parseObservationGroups(text)
  if (!groups.length) {
    return truncateText(text.trim(), config.maxObservationsChars)
  }

  const softTargetTokens = Math.floor(thresholds.reflectionThresholdTokens * 0.75)
  const working = [...groups]

  while (
    working.length > 1 &&
    (estimateTokens(renderObservationGroups(working)) > softTargetTokens ||
      renderObservationGroups(working).length > config.maxObservationsChars ||
      countObservationLines(working) > MAX_OBSERVATION_LINES)
  ) {
    working.shift()
  }

  if (working.length === 1) {
    const single = working[0]!
    while (single.lines.length > 1 && countObservationLines(working) > MAX_OBSERVATION_LINES) {
      single.lines.shift()
    }
    while (
      single.lines.length > 1 &&
      (estimateTokens(renderObservationGroups(working)) > softTargetTokens ||
        renderObservationGroups(working).length > config.maxObservationsChars)
    ) {
      single.lines.shift()
    }
  }

  return truncateText(renderObservationGroups(working), config.maxObservationsChars)
}

function countObservationLines(groups: ObservationGroup[]) {
  return groups.reduce((total, group) => total + group.lines.length + (group.header ? 1 : 0), 0)
}

function sanitizeObserveArgs(
  args: { observations: string; currentTask?: string; suggestedResponse?: string; confirmObservedThrough?: string },
  config: OmConfig,
): SanitizedObserveArgs {
  return {
    observations: sanitizeObservationText(args.observations, config.maxObservationsChars),
    currentTask: sanitizeTextField(args.currentTask, "current-task", config.maxTaskChars),
    suggestedResponse: sanitizeTextField(args.suggestedResponse, "suggested-response", config.maxSuggestedResponseChars),
    confirmObservedThrough: sanitizeSingleLineField(args.confirmObservedThrough, MAX_CURSOR_HINT_CHARS),
  }
}

function sanitizeReflectArgs(
  args: { observations: string; currentTask?: string; suggestedResponse?: string; compressionLevel?: 0 | 1 | 2 | 3 },
  config: OmConfig,
): SanitizedReflectArgs {
  return {
    observations: sanitizeObservationText(args.observations, config.maxObservationsChars),
    currentTask: sanitizeTextField(args.currentTask, "current-task", config.maxTaskChars),
    suggestedResponse: sanitizeTextField(args.suggestedResponse, "suggested-response", config.maxSuggestedResponseChars),
    hasCurrentTask: Object.prototype.hasOwnProperty.call(args, "currentTask"),
    hasSuggestedResponse: Object.prototype.hasOwnProperty.call(args, "suggestedResponse"),
    compressionLevel: args.compressionLevel,
  }
}

function sanitizeObservationText(text: string, maxChars: number) {
  const content = stripWrappedTag(text, "observations") ?? text
  const lines = content
    .replace(/\r/g, "")
    .split("\n")
    .map((line) => line.replace(/[ \t]+$/g, ""))
    .filter((line) => line.trim())
    .map((line) => (line.length > MAX_OBSERVATION_LINE_CHARS ? `${line.slice(0, MAX_OBSERVATION_LINE_CHARS)} … [truncated]` : line))
  return truncateText(lines.join("\n").trim(), maxChars)
}

function sanitizeTextField(text: string | undefined, tag: string, maxChars: number) {
  if (text === undefined) return undefined
  const stripped = stripWrappedTag(text, tag) ?? text
  const lines = dedupeLines(
    stripped
      .replace(/\r/g, "")
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean),
  )
  const joined = truncateText(lines.join("\n"), maxChars).trim()
  return joined || undefined
}

function sanitizeSingleLineField(text: string | undefined, maxChars: number) {
  if (!text) return undefined
  const normalized = normalizeText(text)
  if (!normalized) return undefined
  return truncateText(normalized, maxChars)
}

function stripWrappedTag(text: string, tag: string) {
  const direct = text.match(new RegExp(`^\\s*<${tag}>([\\s\\S]*?)<\\/${tag}>\\s*$`, "i"))
  if (direct?.[1] !== undefined) return direct[1].trim()
  const nested = text.match(new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`, "i"))
  if (nested?.[1] !== undefined) return nested[1].trim()
  return undefined
}

function hasMeaningfulObservationContent(text: string) {
  return text
    .split("\n")
    .some((line) => Boolean(line.trim()) && !/^Date:\s+/i.test(line.trim()))
}

function detectDegenerateRepetition(text: string) {
  if (!text || text.length < 2000) return false

  const windowSize = 200
  const step = Math.max(1, Math.floor(text.length / 50))
  const seen = new Map<string, number>()
  let duplicateWindows = 0
  let totalWindows = 0

  for (let i = 0; i + windowSize <= text.length; i += step) {
    const window = text.slice(i, i + windowSize)
    totalWindows += 1
    const count = (seen.get(window) ?? 0) + 1
    seen.set(window, count)
    if (count > 1) duplicateWindows += 1
  }

  if (totalWindows > 5 && duplicateWindows / totalWindows > 0.4) return true

  for (const line of text.split("\n")) {
    if (line.length > 50_000) return true
  }

  return false
}

function renderMemoryForTokens(memory: OmStateV4["memory"]) {
  return [memory.observations, memory.currentTask ?? "", memory.suggestedResponse ?? ""].join("\n")
}

function getSessionIDFromMessages(
  messages: Array<{ info?: { sessionID?: string; role?: string; id?: string }; parts?: Array<{ type?: string; text?: string }> }>,
) {
  return messages.find((message) => message.info?.sessionID)?.info?.sessionID
}

function pruneMessages(
  messages: Array<{ info: { id: string; role: string; sessionID: string }; parts: Array<{ type?: string; text?: string }> }>,
  state: OmStateV4,
  thresholds: Thresholds,
  requiredTool?: MaintenanceToolID,
) {
  if (requiredTool || state.flags.maintenanceDeferred) {
    return { messages, pruned: false, continuationHint: false, shouldInject: false }
  }

  const userIndexes = messages.flatMap((message, index) => (message.info.role === "user" ? [index] : []))
  if (userIndexes.length < RECENT_USER_PROTECTION + 1) {
    return { messages, pruned: false, continuationHint: false, shouldInject: !!state.memory.observations }
  }
  if (!state.lastObserved.turnAnchorMessageID || !state.memory.observations) {
    return { messages, pruned: false, continuationHint: false, shouldInject: false }
  }

  const protectedStartIndex = userIndexes[userIndexes.length - RECENT_USER_PROTECTION]
  const protectedStartID = messages[protectedStartIndex]?.info.id
  if (!protectedStartID) {
    return { messages, pruned: false, continuationHint: false, shouldInject: false }
  }

  const anchors = userIndexes.map((index) => messages[index]!.info.id)
  const observedIndex = anchors.indexOf(state.lastObserved.turnAnchorMessageID)
  if (observedIndex === -1) {
    return { messages, pruned: false, continuationHint: false, shouldInject: false }
  }

  const cutoffAnchorIndex = Math.min(observedIndex, userIndexes.length - RECENT_USER_PROTECTION - 1)
  if (cutoffAnchorIndex < 0) {
    return { messages, pruned: false, continuationHint: false, shouldInject: true }
  }

  const currentTokens = estimateTokens(JSON.stringify(messages))
  if (currentTokens <= thresholds.rawMessageBudgetTokens) {
    return { messages, pruned: false, continuationHint: false, shouldInject: true }
  }

  const keepFromIndex = userIndexes[cutoffAnchorIndex + 1] ?? 0
  const pruned = messages.slice(keepFromIndex)
  return {
    messages: pruned,
    pruned: pruned.length < messages.length,
    continuationHint: pruned.length < messages.length,
    shouldInject: true,
  }
}

function resolveThresholds(config: OmConfig, contextLimit: number): Thresholds {
  const observationThresholdTokens =
    config.observeThresholdTokens ?? Math.min(30000, Math.floor(contextLimit * 0.35))
  const reflectionThresholdTokens =
    config.reflectThresholdTokens ?? Math.min(40000, Math.floor(contextLimit * 0.5))
  const rawMessageBudgetTokens = config.rawMessageBudgetTokens ?? Math.floor(contextLimit * 0.25)
  return {
    observationThresholdTokens,
    reflectionThresholdTokens,
    rawMessageBudgetTokens,
    observeHardOverdue: Math.floor(observationThresholdTokens * 1.5),
    reflectHardOverdue: Math.floor(reflectionThresholdTokens * 1.25),
  }
}

function statusPayload(state: OmStateV4, config: OmConfig) {
  const thresholds = resolveThresholds(config, DEFAULT_CONTEXT_LIMIT)
  evaluateFlags(state, thresholds)
  const observeInput = buildObserveInput(state, config)
  return {
    sessionID: state.sessionID,
    mode: config.mode,
    thresholds,
    current: {
      bufferTokens: state.buffer.tokenEstimateTotal,
      observableBufferTokens: observableBufferTokenTotal(state),
      memoryTokens: state.memory.tokenEstimate,
      lastObservedTurnAnchor: state.lastObserved.turnAnchorMessageID,
      maintenanceDeferred: !!state.flags.maintenanceDeferred,
      maintenanceDeferredTurns: state.stats.maintenanceDeferredTurns,
      requiredTool: selectMaintenanceTool(state),
      observeCursorHint: state.runtime.observeCursorHint,
      observeInputAnchors: observeInput.anchorCount,
      observeInputTokens: observeInput.tokenEstimate,
      lockContention: !!state.flags.lockContention,
    },
    stats: {
      totalObservedItems: state.stats.totalObservedItems,
      totalReflections: state.stats.totalReflections,
      observeFailures: state.stats.observeFailures,
      reflectFailures: state.stats.reflectFailures,
      maintenanceDeferredTurns: state.stats.maintenanceDeferredTurns,
    },
  }
}

export async function readOmStatus(sessionID: string, directory: string) {
  const [state, config, statePath] = await Promise.all([
    loadState(sessionID, directory),
    getConfig(directory),
    sessionStatePath(directory, sessionID),
  ])
  return {
    status: statusPayload(state, config),
    statePath,
  }
}

async function log(
  client: {
    app: {
      log: (options: {
        body: { service: string; level: "debug" | "info" | "warn" | "error"; message: string; extra?: Record<string, unknown> }
      }) => Promise<unknown>
    }
  },
  level: "debug" | "info" | "warn" | "error",
  message: string,
  extra?: Record<string, unknown>,
) {
  await client.app
    .log({
      body: {
        service: PLUGIN_ID,
        level,
        message,
        extra,
      },
    })
    .catch(() => {})
}

async function forgetState(sessionID: string, directory: string) {
  cache.delete(sessionID)
  runtimeStatus.delete(sessionID)
  const file = await sessionStatePath(directory, sessionID)
  await fs.rm(file, { force: true }).catch(() => {})
}

async function withState(
  sessionID: string,
  directory: string,
  mutate: (state: OmStateV4, config: OmConfig) => Promise<OmStateV4> | OmStateV4,
  onLockContention?: () => Promise<void>,
) {
  const config = await getConfig(directory)
  const state = await loadState(sessionID, directory)
  const lock = await acquireLock(sessionID, directory)
  if (!lock.acquired) {
    state.flags.lockContention = true
    cache.set(sessionID, state)
    if (onLockContention) await onLockContention()
    return state
  }
  try {
    const next = await mutate(state, config)
    next.flags.lockContention = false
    next.generation += 1
    await writeState(directory, next)
    cache.set(sessionID, next)
    return next
  } finally {
    await releaseLock(lock.path)
  }
}

async function loadState(sessionID: string, directory: string) {
  const cached = cache.get(sessionID)
  if (cached) return cached
  const file = await sessionStatePath(directory, sessionID)
  try {
    const text = await fs.readFile(file, "utf8")
    const parsed = JSON.parse(text)
    const state = migrateState(sessionID, parsed)
    cache.set(sessionID, state)
    return state
  } catch {
    const state = createEmptyState(sessionID)
    cache.set(sessionID, state)
    return state
  }
}

async function writeState(directory: string, state: OmStateV4) {
  const file = await sessionStatePath(directory, state.sessionID)
  await fs.mkdir(path.dirname(file), { recursive: true })
  const temp = `${file}.${process.pid}.${Date.now()}.tmp`
  const handle = await fs.open(temp, "w")
  try {
    await handle.writeFile(`${JSON.stringify(state, null, 2)}\n`, "utf8")
    await handle.sync()
  } finally {
    await handle.close()
  }
  await fs.rename(temp, file)
}

async function acquireLock(sessionID: string, directory: string) {
  const lockPath = await sessionLockPath(directory, sessionID)
  await fs.mkdir(path.dirname(lockPath), { recursive: true })
  const now = Date.now()
  try {
    const handle = await fs.open(lockPath, "wx")
    await handle.writeFile(JSON.stringify({ pid: process.pid, writerInstanceID, acquiredAt: now }), "utf8")
    await handle.close()
    return { acquired: true as const, path: lockPath }
  } catch {
    const stale = await isStaleLock(lockPath, now)
    if (stale) {
      await fs.rm(lockPath, { force: true }).catch(() => {})
      return acquireLock(sessionID, directory)
    }
    return { acquired: false as const, path: lockPath }
  }
}

async function isStaleLock(lockPath: string, now: number) {
  try {
    const stat = await fs.stat(lockPath)
    return now - stat.mtimeMs > LOCK_STALE_MS
  } catch {
    return true
  }
}

async function releaseLock(lockPath: string) {
  await fs.rm(lockPath, { force: true }).catch(() => {})
}

async function sessionStatePath(directory: string, sessionID: string) {
  const root = await stateDirectory(directory)
  return path.join(root, `${sessionID}.json`)
}

async function sessionLockPath(directory: string, sessionID: string) {
  const root = await stateDirectory(directory)
  return path.join(root, `${sessionID}.lock`)
}

async function stateDirectory(directory: string) {
  const config = await getConfig(directory)
  if (config.stateDir) return config.stateDir
  const xdg = process.env.XDG_STATE_HOME
  if (xdg) return path.join(xdg, "opencode", "observational-memory")
  return path.join(os.homedir(), ".local", "state", "opencode", "observational-memory")
}

async function getConfig(directory: string) {
  const key = directory
  if (!configCache.has(key)) {
    configCache.set(key, loadConfig(directory))
  }
  return configCache.get(key)!
}

async function loadConfig(directory: string): Promise<OmConfig> {
  const defaults: OmConfig = {
    enabled: true,
    mode: "llm",
    observeThresholdTokens: undefined,
    reflectThresholdTokens: undefined,
    rawMessageBudgetTokens: undefined,
    toolOutputChars: 2000,
    stateDir: "",
    maxObserveInputChars: 24000,
    maxObservationsChars: 64000,
    maxTaskChars: 2000,
    maxSuggestedResponseChars: 4000,
  }

  const globalPath = path.join(os.homedir(), ".config", "opencode", "observational-memory.json")
  const projectPath = path.join(directory, ".opencode", "observational-memory.json")
  const globalConfig = await readJson<Partial<OmConfig>>(globalPath)
  const projectConfig = await readJson<Partial<OmConfig>>(projectPath)
  const envConfig: Partial<OmConfig> = {
    enabled: parseBoolean(process.env.OPENCODE_OM_ENABLED, projectConfig.enabled ?? globalConfig.enabled ?? defaults.enabled),
    mode: parseMode(process.env.OPENCODE_OM_MODE),
    observeThresholdTokens: parseNumber(process.env.OPENCODE_OM_OBSERVE_TOKENS),
    reflectThresholdTokens: parseNumber(process.env.OPENCODE_OM_REFLECT_TOKENS),
    rawMessageBudgetTokens: parseNumber(process.env.OPENCODE_OM_RAW_BUDGET_TOKENS),
    toolOutputChars: parseNumber(process.env.OPENCODE_OM_TOOL_OUTPUT_CHARS) ?? undefined,
    stateDir: process.env.OPENCODE_OM_STATE_DIR,
    maxObserveInputChars: parseNumber(process.env.OPENCODE_OM_MAX_OBSERVE_INPUT_CHARS),
    maxObservationsChars: parseNumber(process.env.OPENCODE_OM_MAX_OBSERVATIONS_CHARS),
    maxTaskChars: parseNumber(process.env.OPENCODE_OM_MAX_TASK_CHARS),
    maxSuggestedResponseChars: parseNumber(process.env.OPENCODE_OM_MAX_SUGGESTED_RESPONSE_CHARS),
  }

  return {
    ...defaults,
    ...globalConfig,
    ...projectConfig,
    ...envConfig,
    enabled: envConfig.enabled ?? projectConfig.enabled ?? globalConfig.enabled ?? defaults.enabled,
    mode: envConfig.mode ?? projectConfig.mode ?? globalConfig.mode ?? defaults.mode,
    observeThresholdTokens:
      envConfig.observeThresholdTokens ??
      projectConfig.observeThresholdTokens ??
      globalConfig.observeThresholdTokens ??
      defaults.observeThresholdTokens,
    reflectThresholdTokens:
      envConfig.reflectThresholdTokens ??
      projectConfig.reflectThresholdTokens ??
      globalConfig.reflectThresholdTokens ??
      defaults.reflectThresholdTokens,
    rawMessageBudgetTokens:
      envConfig.rawMessageBudgetTokens ??
      projectConfig.rawMessageBudgetTokens ??
      globalConfig.rawMessageBudgetTokens ??
      defaults.rawMessageBudgetTokens,
    toolOutputChars:
      envConfig.toolOutputChars ??
      projectConfig.toolOutputChars ??
      globalConfig.toolOutputChars ??
      defaults.toolOutputChars,
    stateDir: envConfig.stateDir ?? projectConfig.stateDir ?? globalConfig.stateDir ?? defaults.stateDir,
    maxObserveInputChars:
      envConfig.maxObserveInputChars ??
      projectConfig.maxObserveInputChars ??
      globalConfig.maxObserveInputChars ??
      defaults.maxObserveInputChars,
    maxObservationsChars:
      envConfig.maxObservationsChars ??
      projectConfig.maxObservationsChars ??
      globalConfig.maxObservationsChars ??
      defaults.maxObservationsChars,
    maxTaskChars:
      envConfig.maxTaskChars ?? projectConfig.maxTaskChars ?? globalConfig.maxTaskChars ?? defaults.maxTaskChars,
    maxSuggestedResponseChars:
      envConfig.maxSuggestedResponseChars ??
      projectConfig.maxSuggestedResponseChars ??
      globalConfig.maxSuggestedResponseChars ??
      defaults.maxSuggestedResponseChars,
  }
}

async function readJson<T>(file: string) {
  try {
    return JSON.parse(await fs.readFile(file, "utf8")) as T
  } catch {
    return {} as T
  }
}

function parseBoolean(value: string | undefined, fallback: boolean) {
  if (value === undefined) return fallback
  return value === "1" || value.toLowerCase() === "true"
}

function parseNumber(value: string | undefined) {
  if (!value) return undefined
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : undefined
}

function parseMode(value: string | undefined) {
  if (value === "llm" || value === "deterministic") return value
  return undefined
}

function setToolDefinitionHint(toolID: MaintenanceToolID | undefined) {
  if (!toolID) {
    toolDefinitionHint = undefined
    return
  }
  toolDefinitionHint = {
    toolID,
    expiresAtMs: Date.now() + TOOL_DEFINITION_HINT_TTL_MS,
  }
}
