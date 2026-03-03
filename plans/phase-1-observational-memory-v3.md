# Phase 1 Implementation Plan v3: Mini-B Observational Memory

Date: 2026-03-02  
Source research: `research/opencode-mastra-memory.md`  
Supersedes: `plans/phase-1-observational-memory-v2.md` for the recommended Phase 1 path

## Summary

Implement **Option 2 / "mini-B"** as the Phase 1 default for an OpenCode plugin:

- Maintain explicit **observational memory (OM)** per **session**.
- Evaluate **observe** and **reflect** thresholds before every outer assistant LLM step (`LLM.stream` invocation).
- Use synchronous internal tools, `om_observe` and `om_reflect`, to update OM before answering when needed.
- Keep the prompt bounded by injecting an OM system block and pruning older observed raw history.
- Preserve user trust by emitting visible maintenance status while synchronous OM work is happening.

This remains intentionally simpler than full Mastra OM:

- no background observer / reflector agents
- no async buffering or activation markers
- no scheduler-driven OM maintenance
- no cross-session or per-repo OM in Phase 1

Goal: capture most of the **behavioral** benefits of OM without requiring OpenCode core changes.

## Implementation TODO Status

- [x] Revise the Phase 1 plan text to reflect implementation-safe tool IDs, outer-step trigger semantics, and explicit status signaling.
- [x] Create the project-local plugin scaffold under `.opencode/plugins/` with dependency/config support needed for loading.
- [x] Implement OM state storage, buffering, maintenance tools, and prompt/pruning hooks.
- [x] Validate plugin loading and core behavior paths with focused local checks.
- [x] Document run/try instructions and mark final implementation status.

---

## Implementation Baseline

This plan is pinned to the research baseline:

- OpenCode: `anomalyco/opencode@78069369e2253c9788c09b7a71478d140c9741f2` on branch `dev`
- Mastra: `mastra-ai/mastra@23b43ddd0e3db05dee828c2733faa2496b7b0319` on branch `main`

Implementation precondition:

- Before coding starts, check out those SHAs into `repos/opencode` and `repos/mastra`, or explicitly revise this plan to a newer upstream target.
- If the current OpenCode plugin API differs materially from the pinned baseline, update this document before implementation rather than silently adapting behavior.

---

## Scope Decision: Per-Session, Not Per-Repo

Phase 1 OM is **per session** by design.

Reasoning:

- Observational memory answers "what is happening in this conversation right now?"
- That is inherently session-bound and should track turn-by-turn local continuity.
- Per-repo scope is better reserved for later **working memory** and **semantic recall** phases, where durable facts, preferences, and codebase knowledge belong.

Locked scope rule:

- `sessionID` is the OM storage and pruning boundary in Phase 1.
- No OM state is shared across sessions, even when multiple sessions belong to the same repo.

---

## Locked Decisions

- **Scope:** per-session OM only in Phase 1.
- **Baseline:** target the pinned OpenCode and Mastra SHAs above.
- **Storage:** plugin-owned local state outside the repo.
- **Trigger point:** evaluate OM before every outer assistant LLM step (`LLM.stream` invocation).
- **Maintenance model:** synchronous `om_observe` / `om_reflect` tools.
- **Prompt model:** inject OM every turn; prune only when OM is current.
- **Compaction policy:** native OpenCode compaction remains enabled as an emergency fallback, not the primary OM mechanism.
- **Pruning floor:** never prune the protected "tip-of-spear" window.
- **Durability model:** single writer per session in Phase 1.

---

## User-Facing Constraints

These are part of the implementation contract, not optional polish.

### 1) UX Signaling for Synchronous Maintenance

Whenever OM maintenance delays an answer, the plugin must emit a visible status log or event.

Required examples:

- `Context limit reached. Observing recent history...`
- `Compressing memory before continuing...`
- `Memory maintenance deferred. Continuing with raw context.`

Rules:

- Status signaling must happen before the maintenance tool call begins.
- Status signaling must also happen on maintenance failure or deferral.
- Phase 1 default status channel: plugin operational logs via `client.app.log()`, plus tool `title` / `metadata` updates while `om_*` tools are running.
- For deferral cases where no `om_*` tool actually runs, a plugin log entry is sufficient; do not force assistant prose just to surface maintenance state.
- These signals are operational UI/log output, not user-facing assistant prose.

### 2) Strict Tip-of-Spear Protection

The plugin must not prune the most recent conversational tip.

Locked rule:

- Never prune any prompt-visible content at or after the **second-most-recent user message**.

In practice, this preserves at least:

- latest user message
- immediately previous assistant turn
- immediately previous user message
- contiguous tool-result group associated with that previous assistant turn

This is stricter than v2 and is intended to reduce "I don't see the file/error you just mentioned" failures.

### 3) Session Scope Is Intentional

This plan intentionally differs from the broader research recommendation of per-repo memory for later phases.

Validation:

- Per-session OM is the correct Phase 1 choice.
- Per-repo memory remains appropriate for future working memory and semantic recall, not observational memory.

---

## Core Mini-B Behavior

### High-level flow

1. Capture normalized session activity into an unobserved buffer:
   - user messages
   - finalized assistant text
   - truncated tool outcomes

2. Before each outer assistant LLM step (`LLM.stream` invocation):
   - if unobserved content exceeds the observation threshold, require `om_observe`
   - else if OM content exceeds the reflection threshold, require `om_reflect`
   - else inject OM normally

3. When OM is current:
   - inject `<observations>`, `<current-task>`, and optional `<suggested-response>`
   - drop raw messages already covered by OM
   - keep only a bounded protected recent tail
   - insert a continuation hint when older raw history is omitted

4. If OM maintenance cannot safely complete:
   - do not prune for that turn
   - emit a status signal
   - fall back to raw prompt handling and native compaction safety

### Required plugin hooks

- `chat.message` for user input
- `tool.execute.after` for tool outcomes
- `event` for finalized assistant output
- `experimental.chat.system.transform` for OM injection and maintenance instructions
- `experimental.chat.messages.transform` for raw-tail pruning and continuation hint
- `tool` for `om_observe`, `om_reflect`, `om_status`, `om_export`, `om_forget`

---

## Canonical Turn Model

Pruning and observation must operate on a **turn-group** model, not arbitrary individual parts.

### Turn-group definition

A turn group is anchored by a user message and includes:

- that user message
- the following assistant reply
- any contiguous tool calls and tool results associated with that assistant reply
- any assistant completion text that follows those tool results

The next user message starts a new turn group.

### Cursor authority

Phase 1 uses a **turn-anchor cursor**, not a free-form message cursor.

Locked default:

- primary cursor: `turnAnchorMessageID` for the latest fully observed turn group
- fallback cursor: `atMs` only when IDs are unavailable

Pruning rule:

- Pruning may only cut at completed turn-group boundaries strictly older than the protected tip-of-spear window.

This avoids partial-turn pruning and reduces ambiguity around tool-result grouping.

---

## Native Compaction Coexistence

OpenCode's native compaction stays enabled in Phase 1, but only as a fallback safety mechanism.

Locked policy:

- OM does **not** replace core compaction globally.
- OM is the first-line continuity mechanism during normal long sessions.
- Native compaction remains the emergency overflow path when OM cannot keep the prompt under budget.

Additional rules:

- Existing compaction summary messages are excluded from OM buffering.
- Synthetic OM reminder messages are excluded from OM buffering.
- OM never attempts to reconstruct or prune across history that has already been compacted away by OpenCode.
- After a compaction boundary, OM resumes from the visible post-compaction transcript only.

This avoids summary-of-summary drift and keeps the plugin compatible with current OpenCode behavior.

---

## Maintenance Enforcement and Loop Policy

Phase 1 is synchronous, but it must not spin indefinitely or silently hang.

### Normal maintenance policy

When maintenance is required:

- emit a maintenance status signal
- inject an explicit system rule: "Before answering, call `om_observe`." or "Before answering, call `om_reflect`."
- strengthen the tool description for the required tool on that turn

### Attempt limits

Use:

- `maxMaintenanceAttemptsPerTurn = 2`
- `maxConsecutiveDeferredTurns = 2`

### Non-compliance handling

If the model ignores required maintenance:

1. First ignored attempt:
   - mark the turn as `maintenanceDeferred`
   - emit status: `Memory maintenance was skipped once. Retrying...`
   - retry once only if the OpenCode loop can do so without surfacing a partial answer

2. Second ignored attempt, or retry not technically possible:
   - accept the turn without OM pruning
   - increment failure/defer counters
   - emit status: `Memory maintenance deferred. Continuing with raw context.`

### Hard-overdue handling

If OM is hard overdue:

- do not allow OM-based pruning until maintenance succeeds
- do not keep retrying more than the per-turn limit
- rely on native compaction / overflow safety if prompt size is still too large

Implementation gate:

- If the pinned OpenCode plugin API cannot safely restart a turn after a non-compliant answer, do not fake hidden retries. In that case, use the "defer and skip pruning" path above.
- Phase 1 locked interpretation of "before every LLM call": evaluate at each outer assistant step (`LLM.stream` invocation), not at provider-internal sub-calls inside a single streamed tool-use loop.

---

## Thresholds and Budgets

These are the Phase 1 defaults and should be treated as the implementation contract.

- `observationThresholdTokens = min(30_000, floor(model.limit.context * 0.35))`
- `reflectionThresholdTokens = min(40_000, floor(model.limit.context * 0.50))`
- `rawMessageBudgetTokens = floor(model.limit.context * 0.25)`
- `toolOutputChars = 2_000` per tool result
- token estimate heuristic: `ceil(chars / 4)`

Operational ordering:

- if both thresholds are exceeded, run `om_observe` first, then `om_reflect` on the next loop iteration
- prefer `reflect` before `observe` only when OM itself is oversized and the unobserved buffer is too small to justify delaying compression

### Hard-overdue thresholds

Add explicit backpressure:

- `observeHardOverdue = floor(observationThresholdTokens * 1.5)`
- `reflectHardOverdue = floor(reflectionThresholdTokens * 1.25)`

When hard overdue:

- emit a status signal
- require maintenance before OM-based pruning resumes
- if maintenance fails or is ignored, do not prune and allow native compaction to protect the turn

---

## Pre-LLM Overflow Policy

This closes the largest remaining implementation ambiguity from v2.

### Estimated prompt caps

Define:

- `softPromptCap = floor(model.limit.context * 0.80)`
- `hardPromptCap = floor(model.limit.context * 0.90)`

Estimate prompt size using:

- system prompt
- OM block if injected
- visible raw messages
- continuation hint if present
- required maintenance instruction/tool overhead for maintenance turns

### Overflow behavior

1. If estimate is below `softPromptCap`:
   - normal OM behavior

2. If estimate exceeds `softPromptCap` and OM is current:
   - prune aggressively down to the protected floor plus OM block

3. If estimate exceeds `softPromptCap` and OM is not current:
   - attempt maintenance once within the normal per-turn limit

4. If estimate exceeds `hardPromptCap` and OM is still not current:
   - disable OM injection for that turn
   - skip OM pruning for that turn
   - emit status: `Context still too large. Falling back to native compaction handling.`
   - let OpenCode's native overflow / compaction path take over

This prevents OM itself from pushing the request over the model limit.

---

## Prompt Contract

### System block injected when OM is current

```xml
<observations>...</observations>
<current-task>...</current-task>
<suggested-response>...</suggested-response>
```

Required rules:

- observations are authoritative for pruned earlier context
- use the newest observation when conflicts exist
- do not mention the memory system to the user

### Continuation hint when history is pruned

```xml
<system-reminder>
This is not a new conversation. Earlier context was compressed into observations.
Continue naturally without referencing the memory system.
</system-reminder>
```

### Pruning floor

When pruning is active, always keep:

- all prompt-visible content at or after the second-most-recent user message
- the latest completed turn group before that protected point if needed to satisfy the raw budget more safely than cutting inside a group

Do not prune:

- the protected tip-of-spear window
- pending-turn content
- OM maintenance tool traffic until the maintenance turn is complete

---

## Assistant Capture and Recovery

### Capture source

Locked default:

- use finalized assistant text from `event` subscriptions as the primary source
- use stored-message reconstruction only for recovery paths

### Recovery behavior

If the event stream misses a finalized assistant message:

- do not immediately rewrite old OM
- append reconstructed assistant content only if it can be mapped to a completed turn group not yet observed
- mark the session as having used recovery capture in `stats`

This keeps the live path simple while still allowing crash/restart recovery.

---

## Bootstrap and Resume Policy

### Fresh session

- initialize empty OM state
- do not prune until the first successful `om.observe`

### Existing session with no OM state

- do not backfill the entire persisted transcript in Phase 1
- start observing from the currently visible live transcript only
- until the first successful observation, rely on raw history and native compaction behavior

### Corrupt or missing state file

- emit a status warning
- recreate empty OM state
- disable OM pruning for the current turn
- rebuild forward from future visible context rather than trying to reconstruct the full past session

This avoids expensive or low-confidence whole-transcript summarization during recovery.

---

## State Schema

```ts
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
    items: Array<{
      kind: "user" | "assistant" | "tool"
      id: string
      turnAnchorMessageID: string
      atMs: number
      text: string
      tokenEstimate: number
    }>
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
}
```

---

## State Durability and Concurrency

Phase 1 explicitly assumes a **single writer per session**.

### Durability model

- on-disk format: JSON file per session
- writes: `write temp -> fsync -> rename`
- in-process access: per-session mutex
- cache authority: in-memory cache is authoritative only while the current process holds the session lock

### Session lock rule

Use a per-session advisory lock or lock file.

Locked behavior:

- if the plugin acquires the lock, it may mutate OM state and prune based on that state
- if lock acquisition fails, mark `lockContention`
- while `lockContention` is set:
  - do not mutate OM state
  - do not prune based on potentially stale OM
  - emit status: `Observational memory is in passive mode because another process owns this session.`

### Disk-vs-cache recovery

- disk is authoritative on startup
- after any read/write error, discard the in-memory cache for that session and reload from disk if possible
- if reload fails, recreate empty state and disable pruning for the current turn

This is sufficient for a plugin-first Phase 1 and avoids half-defined multi-process behavior.

---

## Config Surface

Support both env vars and JSON config files.

Precedence:

1. environment variables
2. project JSON config
3. global JSON config
4. built-in defaults

Recommended keys:

- `OPENCODE_OM_ENABLED`
- `OPENCODE_OM_OBSERVE_TOKENS`
- `OPENCODE_OM_REFLECT_TOKENS`
- `OPENCODE_OM_RAW_BUDGET_TOKENS`
- `OPENCODE_OM_TOOL_OUTPUT_CHARS`

Optional JSON config locations:

- project: `<repo>/.opencode/observational-memory.json`
- global: `~/.config/opencode/observational-memory.json`

---

## Tool Policy

### `om_observe`

Purpose:

- turn the unobserved buffer into structured memory for the current session

Tool behavior:

- consume current buffered items
- update `memory.observations`, `currentTask`, and optional `suggestedResponse`
- advance `lastObserved.turnAnchorMessageID`
- clear the buffer

### `om_reflect`

Purpose:

- compress or rewrite `memory.observations` when OM itself grows too large

Tool behavior:

- replace `memory.observations`
- update `memory.tokenEstimate`
- increment reflection stats

### `om_status`

Must expose:

- thresholds and current estimates
- last observed turn anchor
- maintenance deferral counts
- lock contention state

### `om_export`

Locked default:

- export full OM content only when explicitly requested
- no automatic background export

### `om_forget`

Locked default:

- clear active OM state and diagnostics for the current session
- remove the on-disk state file when possible

---

## Recommended Phase 1 Sequence

Implement in this order:

1. Core Mini-B with pinned baseline, turn-group cursoring, protected pruning floor, and native-compaction coexistence
2. UX signaling
3. Single-writer locking and recovery rules
4. Hysteresis / debounce
5. Better tool-outcome digestion
6. Task stability rules
7. Hard-overdue maintenance guard

This sequence keeps the architecture simple while resolving the highest-risk correctness and UX gaps first.

---

## Success Criteria

- Long tool-heavy sessions continue without the user manually managing context.
- The user sees status when synchronous OM maintenance pauses the reply path.
- The prompt stays bounded without pruning the protected conversational tip.
- OM and native compaction do not fight each other or create double-summary drift.
- Recovery from missed events, state corruption, or lock contention degrades safely.

---

## What Phase 1 Still Does Not Include

- background observer / reflector runs
- async observation buffering
- activation markers for precomputed observation chunks
- per-repo or cross-session observational memory
- richer multi-record OM storage beyond the single active state
- semantic recall or working memory

Those remain later phases after the synchronous session-scoped OM path is validated.

---

## Implementation Status

Implementation note (2026-03-03): the first runnable plugin now lives at `.opencode/plugins/observational-memory.ts`, with local dependency support in `.opencode/package.json` and project defaults in `.opencode/observational-memory.json`.

Implementation note (2026-03-03): `om_observe` and `om_reflect` currently use a deterministic local digest/compression pass rather than a separate model-backed summarization call. This keeps Phase 1 synchronous and self-contained within current OpenCode plugin constraints.

## Try It

1. Run OpenCode from the repo root so it loads the local `.opencode/plugins/` directory.
2. If OpenCode does not auto-install local plugin dependencies in `.opencode/`, run `npm install` in `.opencode/`.
3. Start or continue a long session in this repo. The plugin will auto-capture user messages, finalized assistant text, and truncated tool output for that session.
4. Manual tools are available for inspection and control: `om_status`, `om_export`, `om_observe`, `om_reflect`, `om_forget`.
5. Optional overrides:
   `OPENCODE_OM_ENABLED`
   `OPENCODE_OM_OBSERVE_TOKENS`
   `OPENCODE_OM_REFLECT_TOKENS`
   `OPENCODE_OM_RAW_BUDGET_TOKENS`
   `OPENCODE_OM_TOOL_OUTPUT_CHARS`
   `OPENCODE_OM_STATE_DIR`
6. Smoke test helpers:
   `node --experimental-strip-types scripts/smoke-om-plugin.mjs`
   `node --experimental-strip-types scripts/smoke-om-plugin.mjs --opencode`

## Validation Notes

Validated locally on 2026-03-03 by:

- importing the plugin module directly under Node 25 with `--experimental-strip-types`
- initializing the plugin and confirming all expected hooks and tools are exported
- mocking `chat.message`, `tool.execute.after`, `message.updated`, and the chat transform hooks to verify state capture, OM block injection, and protected-tail pruning behavior
- running `scripts/smoke-om-plugin.mjs` successfully in plugin mode after correcting the plugin schema version mismatch to Zod 4

---

## Minor Issues (Non-Blocking)

Review note (2026-03-03): these items should not block a first-pass implementation, but should be cleaned up during or immediately after Phase 1.

- The current runnable plugin uses deterministic local observe/reflect heuristics rather than model-backed summarization; quality tuning for very noisy sessions is still open.
- Dynamic per-turn strengthening of tool descriptions is not implemented, because the current `tool.definition` hook does not carry session context.
- Prompt budgeting still uses coarse `chars / 4` estimation rather than provider-accurate tokenization.
- Tool attachments (images/files) are not buffered into OM; only textual tool output is currently digested.
- Validation is hook-level and mocked, not yet an end-to-end OpenCode session run against a live model.
