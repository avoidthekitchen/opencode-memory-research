#!/usr/bin/env node

import { access } from "node:fs/promises"
import path from "node:path"
import process from "node:process"
import { fileURLToPath, pathToFileURL } from "node:url"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const sessionID = parseSessionID(process.argv.slice(2))

if (!sessionID) {
  process.stderr.write("Usage: node --experimental-strip-types scripts/om-status.mjs --session <session-id>\n")
  process.stderr.write("   or: node --experimental-strip-types scripts/om-status.mjs <session-id>\n")
  process.exit(1)
}

const pluginModule = await import(pathToFileURL(path.join(root, ".opencode", "plugins", "observational-memory.ts")).href)
const { readOmStatus } = pluginModule
const { status, statePath } = await readOmStatus(sessionID, root)
const stateExists = await access(statePath).then(() => true, () => false)

process.stdout.write(formatCompactStatus(status, statePath, stateExists))

function parseSessionID(args) {
  const positionals = []
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]
    if (arg === "--session") {
      return args[index + 1]
    }
    if (!arg.startsWith("-")) {
      positionals.push(arg)
    }
  }
  return positionals[0]
}

function formatCompactStatus(status, statePath, stateExists) {
  const { thresholds, current, scope } = status
  const lines = [
    `session=${status.sessionID} scope=${scope.mode} state=${stateExists ? "present" : "missing"}`,
    `buffer=${current.bufferTokens} memory=${current.memoryTokens} lastObserved=${current.lastObservedTurnAnchor ?? "-"}`,
    `deferred=${current.maintenanceDeferredTurns} lock=${current.lockContention ? "yes" : "no"}`,
    `observe=${thresholds.observationThresholdTokens} reflect=${thresholds.reflectionThresholdTokens} raw=${thresholds.rawMessageBudgetTokens} shared=${thresholds.sharedBudgetTokens ?? "-"}`,
    `tailUsers=${current.tailRetentionUserTurns} tailTokens=${current.tailRetentionTokens ?? "-"} cutoff=${current.effectiveCutoffAnchor ?? "-"} protectedTail=${current.protectedTailAnchor ?? "-"}`,
    `hardObserve=${thresholds.observeHardOverdue} hardReflect=${thresholds.reflectHardOverdue}`,
    `path=${statePath}`,
  ]
  return `${lines.join("\n")}\n`
}
