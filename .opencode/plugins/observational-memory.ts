import os from "node:os"
import path from "node:path"
import { createHash, randomUUID } from "node:crypto"
import { promises as fs } from "node:fs"
import * as z from "zod/v4"

const PLUGIN_ID = "observational-memory"
const STATE_VERSION = 3
const LOCK_STALE_MS = 5 * 60 * 1000
const RECENT_USER_PROTECTION = 2

type BufferKind = "user" | "assistant" | "tool"

type BufferItem = {
  kind: BufferKind
  id: string
  turnAnchorMessageID: string
  atMs: number
  text: string
  tokenEstimate: number
}

type OmStateV3 = {
  version: 3
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
  }
}

type OmConfig = {
  enabled: boolean
  observeThresholdTokens?: number
  reflectThresholdTokens?: number
  rawMessageBudgetTokens?: number
  toolOutputChars: number
  stateDir?: string
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
  maintenanceLog?: string
}

const cache = new Map<string, OmStateV3>()
const runtimeStatus = new Map<string, RuntimeStatus>()
const configCache = new Map<string, Promise<OmConfig>>()
const writerInstanceID = randomUUID()

function defineTool<Args extends z.ZodRawShape>(input: {
  description: string
  args: Args
  execute: (args: z.infer<z.ZodObject<Args>>, context: { sessionID: string; metadata: (input: { title?: string; metadata?: Record<string, unknown> }) => void }) => Promise<string>
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
          "Update observational memory for this session by digesting buffered conversation and tool activity into compact observations.",
        args: {
          force: z.boolean().optional(),
        },
        async execute(args, context) {
          context.metadata({ title: "Observing recent history..." })
          const state = await withState(
            context.sessionID,
            directory,
            async (current, cfg) => observe(current, cfg, { force: args.force === true }),
            async () => {
              context.metadata({
                title: "Observational memory passive",
                metadata: { reason: "lock-contention" },
              })
            },
          )
          return JSON.stringify(statusPayload(state, await getConfig(directory)))
        },
      }),
      om_reflect: defineTool({
        description:
          "Compress existing observational memory when the observations block has grown too large.",
        args: {
          force: z.boolean().optional(),
        },
        async execute(args, context) {
          context.metadata({ title: "Compressing memory..." })
          const state = await withState(
            context.sessionID,
            directory,
            async (current) => reflect(current, { force: args.force === true }),
            async () => {
              context.metadata({
                title: "Observational memory passive",
                metadata: { reason: "lock-contention" },
              })
            },
          )
          return JSON.stringify(statusPayload(state, await getConfig(directory)))
        },
      }),
      om_status: defineTool({
        description: "Show observational memory status, thresholds, and current estimates for this session.",
        args: {},
        async execute(_args, context) {
          const state = await loadState(context.sessionID, directory)
          return JSON.stringify(statusPayload(state, await getConfig(directory)), null, 2)
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
          state.runtime.continuationHint = false
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
      const thresholds = resolveThresholds(config, 128000)
      const prune = pruneMessages(output.messages, state, thresholds)
      runtimeStatus.set(sessionID, {
        shouldInject: prune.shouldInject,
        shouldPrune: prune.pruned,
        continuationHint: prune.continuationHint,
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
      if (ready.memory.observations && !ready.flags.observeRequired && !ready.flags.reflectRequired && !ready.flags.lockContention) {
        output.system.push(renderOmBlock(ready.memory))
        runtime.shouldInject = true
      }
      if (runtime.continuationHint) {
        output.system.push(renderContinuationHint())
      }
      if (ready.flags.maintenanceDeferred && runtime.shouldInject === false) {
        output.system.push(
          "<system-reminder>Earlier context could not be refreshed this turn. Prefer the visible recent transcript.</system-reminder>",
        )
      }
      runtimeStatus.set(input.sessionID, runtime)
    },
  }
}

function createEmptyState(sessionID: string): OmStateV3 {
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

function appendBufferItem(state: OmStateV3, item: BufferItem) {
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
      if (state.flags.observeRequired) {
        await report("Context limit reached. Observing recent history...", {
          bufferTokens: state.buffer.tokenEstimateTotal,
        })
        state = await observe(state, config, { force: true })
        evaluateFlags(state, thresholds)
      }
      if (!state.flags.observeRequired && state.flags.reflectRequired) {
        await report("Compressing memory before continuing...", {
          memoryTokens: state.memory.tokenEstimate,
        })
        state = await reflect(state, { force: true })
        evaluateFlags(state, thresholds)
      }
      if (state.flags.observeRequired || state.flags.reflectRequired) {
        state.flags.maintenanceDeferred = true
        state.stats.maintenanceDeferredTurns += 1
        await report("Memory maintenance deferred. Continuing with raw context.", {
          observeRequired: state.flags.observeRequired,
          reflectRequired: state.flags.reflectRequired,
        })
      } else {
        state.flags.maintenanceDeferred = false
      }
      return state
    },
    async () => {
      await report("Observational memory is in passive mode because another process owns this session.", {
        lockContention: true,
      })
    },
  )
}

function observe(state: OmStateV3, config: OmConfig, options: { force: boolean }) {
  const completedAnchors = completedAnchorIDs(state.buffer.items)
  if (!completedAnchors.length && !options.force) {
    state.flags.observeRequired = false
    return state
  }
  const observedItems = state.buffer.items.filter((item) => completedAnchors.has(item.turnAnchorMessageID))
  if (!observedItems.length) {
    state.flags.observeRequired = false
    return state
  }

  const grouped = new Map<string, BufferItem[]>()
  for (const item of observedItems) {
    const existing = grouped.get(item.turnAnchorMessageID) ?? []
    existing.push(item)
    grouped.set(item.turnAnchorMessageID, existing)
  }
  const chunks = Array.from(grouped.entries())
    .sort((a, b) => a[1][0].atMs - b[1][0].atMs)
    .map(([anchor, items]) => summarizeObservedTurn(anchor, items, config.toolOutputChars))
    .filter(Boolean)

  const prior = state.memory.observations ? state.memory.observations.split("\n").filter(Boolean) : []
  const merged = dedupeLines([...prior, ...chunks])
  const observations = merged.slice(-24).join("\n")
  const currentTask = inferCurrentTask(state)

  state.memory.observations = observations
  state.memory.currentTask = currentTask || undefined
  state.memory.suggestedResponse = undefined
  state.memory.tokenEstimate = estimateTokens(
    [state.memory.observations, state.memory.currentTask ?? "", state.memory.suggestedResponse ?? ""].join("\n"),
  )
  state.memory.updatedAtMs = Date.now()
  state.lastObserved.turnAnchorMessageID = lastCompletedAnchor(observedItems)
  state.lastObserved.atMs = observedItems[observedItems.length - 1]?.atMs
  state.stats.totalObservedItems += observedItems.length
  state.buffer.items = state.buffer.items.filter((item) => !completedAnchors.has(item.turnAnchorMessageID))
  state.buffer.tokenEstimateTotal = state.buffer.items.reduce((total, item) => total + item.tokenEstimate, 0)
  state.flags.observeRequired = false
  return state
}

function reflect(state: OmStateV3, options: { force: boolean }) {
  if (!state.memory.observations && !options.force) {
    state.flags.reflectRequired = false
    return state
  }
  const lines = state.memory.observations
    .split("\n")
    .map((line) => normalizeText(line))
    .filter(Boolean)
  const compacted = dedupeLines(lines).slice(-12)
  state.memory.observations = compacted.join("\n")
  state.memory.tokenEstimate = estimateTokens(
    [state.memory.observations, state.memory.currentTask ?? "", state.memory.suggestedResponse ?? ""].join("\n"),
  )
  state.memory.updatedAtMs = Date.now()
  state.stats.totalReflections += 1
  state.flags.reflectRequired = false
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

function inferCurrentTask(state: OmStateV3) {
  const pendingUser = [...state.buffer.items].reverse().find((item) => item.kind === "user")
  if (pendingUser) return truncateText(pendingUser.text, 240)
  const lastObservation = state.memory.observations.split("\n").filter(Boolean).at(-1)
  return lastObservation ? truncateText(lastObservation, 240) : ""
}

function dedupeLines(lines: string[]) {
  const seen = new Set<string>()
  const ordered: string[] = []
  for (const line of lines.toReversed()) {
    if (seen.has(line)) continue
    seen.add(line)
    ordered.push(line)
  }
  return ordered.toReversed()
}

function completedAnchorIDs(items: BufferItem[]) {
  const anchors = new Set<string>()
  for (const item of items) {
    if (item.kind === "assistant") anchors.add(item.turnAnchorMessageID)
  }
  return anchors
}

function lastCompletedAnchor(items: BufferItem[]) {
  const assistant = [...items].reverse().find((item) => item.kind === "assistant")
  return assistant?.turnAnchorMessageID
}

function evaluateFlags(state: OmStateV3, thresholds: Thresholds) {
  state.flags.observeRequired = state.buffer.tokenEstimateTotal >= thresholds.observationThresholdTokens
  state.flags.reflectRequired = state.memory.tokenEstimate >= thresholds.reflectionThresholdTokens
}

function renderOmBlock(memory: OmStateV3["memory"]) {
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

function getSessionIDFromMessages(
  messages: Array<{ info?: { sessionID?: string; role?: string; id?: string }; parts?: Array<{ type?: string; text?: string }> }>,
) {
  return messages.find((message) => message.info?.sessionID)?.info?.sessionID
}

function pruneMessages(
  messages: Array<{ info: { id: string; role: string; sessionID: string }; parts: Array<{ type?: string; text?: string }> }>,
  state: OmStateV3,
  thresholds: Thresholds,
) {
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

function statusPayload(state: OmStateV3, config: OmConfig) {
  const thresholds = resolveThresholds(config, 128000)
  return {
    sessionID: state.sessionID,
    thresholds,
    current: {
      bufferTokens: state.buffer.tokenEstimateTotal,
      memoryTokens: state.memory.tokenEstimate,
      lastObservedTurnAnchor: state.lastObserved.turnAnchorMessageID,
      maintenanceDeferredTurns: state.stats.maintenanceDeferredTurns,
      lockContention: !!state.flags.lockContention,
    },
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
  await client.app.log({
    body: {
      service: PLUGIN_ID,
      level,
      message,
      extra,
    },
  }).catch(() => {})
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
  mutate: (state: OmStateV3, config: OmConfig) => Promise<OmStateV3> | OmStateV3,
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
    const parsed = JSON.parse(text) as OmStateV3
    const state = parsed.version === STATE_VERSION ? parsed : createEmptyState(sessionID)
    cache.set(sessionID, state)
    return state
  } catch {
    const state = createEmptyState(sessionID)
    cache.set(sessionID, state)
    return state
  }
}

async function writeState(directory: string, state: OmStateV3) {
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
    observeThresholdTokens: undefined,
    reflectThresholdTokens: undefined,
    rawMessageBudgetTokens: undefined,
    toolOutputChars: 2000,
    stateDir: "",
  }

  const globalPath = path.join(os.homedir(), ".config", "opencode", "observational-memory.json")
  const projectPath = path.join(directory, ".opencode", "observational-memory.json")
  const globalConfig = await readJson<Partial<OmConfig>>(globalPath)
  const projectConfig = await readJson<Partial<OmConfig>>(projectPath)
  const envConfig: Partial<OmConfig> = {
    enabled: parseBoolean(process.env.OPENCODE_OM_ENABLED, projectConfig.enabled ?? globalConfig.enabled ?? defaults.enabled),
    observeThresholdTokens: parseNumber(process.env.OPENCODE_OM_OBSERVE_TOKENS),
    reflectThresholdTokens: parseNumber(process.env.OPENCODE_OM_REFLECT_TOKENS),
    rawMessageBudgetTokens: parseNumber(process.env.OPENCODE_OM_RAW_BUDGET_TOKENS),
    toolOutputChars: parseNumber(process.env.OPENCODE_OM_TOOL_OUTPUT_CHARS) ?? undefined,
    stateDir: process.env.OPENCODE_OM_STATE_DIR,
  }
  return {
    ...defaults,
    ...projectConfig,
    ...globalConfig,
    ...envConfig,
    enabled: envConfig.enabled ?? projectConfig.enabled ?? globalConfig.enabled ?? defaults.enabled,
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
