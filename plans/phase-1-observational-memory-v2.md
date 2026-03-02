# Phase 1 Implementation Plan v2: Mini-B Observational Memory

Date: 2026-03-02  
Source research: `research/opencode-mastra-memory.md`  
Supersedes: `plans/phase-1-observational-memory.md` for the recommended Phase 1 path

## Summary

Implement **Option 2 / “mini-B”** as the Phase 1 default:

- Maintain explicit OM state per **session**.
- Evaluate **observation** and **reflection** thresholds on every turn.
- Use synchronous internal tools, `om.observe` and `om.reflect`, to update OM before answering when needed.
- Keep the prompt bounded by injecting an OM system block and pruning older observed raw messages, leaving only a bounded recent tail plus a continuation hint.

This is intentionally **not** full Mastra OM:
- No background observer/reflector agents.
- No async buffering / activation pipeline.
- No scheduler-driven OM maintenance.

Goal: capture most of the **behavioral** benefits of OM with a simpler, synchronous implementation.

---

## Locked Decisions

- **Scope:** per-session OM only in Phase 1.
- **Storage:** plugin-owned local state outside the repo.
- **Trigger point:** evaluate OM before every LLM call.
- **Prompt model:** inject OM every turn; prune older observed raw history when OM is up to date.
- **Recommendation:** ship core `mini-B` first, then add low-complexity hardening phases.

---

## Core Mini-B (Initial Phase 1)

### Behavior

1. Capture normalized session activity into an unobserved buffer:
   - user messages
   - finalized assistant text
   - truncated tool outcomes

2. Before each LLM call:
   - if unobserved content exceeds the observation threshold, require `om.observe`
   - else if OM content exceeds the reflection threshold, require `om.reflect`
   - else inject OM normally

3. When OM is current:
   - inject `<observations>`, `<current-task>`, and optional `<suggested-response>`
   - drop raw messages already covered by OM
   - keep only a bounded unobserved tail
   - insert a continuation hint when older raw history is omitted

### Plugin hooks

- `chat.message` for user input
- `tool.execute.after` for tool outcomes
- `event` for finalized assistant output
- `experimental.chat.system.transform` for OM injection and maintenance instructions
- `experimental.chat.messages.transform` for raw-tail pruning and continuation hint
- `tool` for `om.observe`, `om.reflect`, `om.status`, `om.export`, `om.forget`

### Minimal state schema

```ts
type OmStateV2 = {
  version: 2
  sessionID: string
  lastObserved: { messageID?: string; atMs?: number }
  buffer: {
    items: Array<{
      kind: "user" | "assistant" | "tool"
      id: string
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
  }
  flags: {
    observeRequired?: boolean
    reflectRequired?: boolean
  }
}
```

### Defined thresholds and budgets

These are explicitly defined in v2 and should be treated as the default implementation contract:

- `observationThresholdTokens = min(30_000, floor(model.limit.context * 0.35))`
- `reflectionThresholdTokens = min(40_000, floor(model.limit.context * 0.50))`
- `rawMessageBudgetTokens = floor(model.limit.context * 0.25)`
- `toolOutputChars = 2_000` default per tool result
- token estimate heuristic: `ceil(chars / 4)`

Operational rule:
- Prefer `reflect` over `observe` only when OM itself is oversized and the unobserved buffer is small enough not to delay compression.
- If both thresholds are exceeded, run `om.observe` first, then `om.reflect` on the next loop iteration.

### Prompt contract

System block injected every turn:

```xml
<observations>...</observations>
<current-task>...</current-task>
<suggested-response>...</suggested-response>
```

Continuation hint when history is pruned:

```xml
<system-reminder>
This is not a new conversation. Earlier context was compressed into observations.
Continue naturally without referencing the memory system.
</system-reminder>
```

### Success criteria

- Long tool-heavy sessions continue without user-triggered compaction.
- The prompt remains bounded and stable.
- Older observed history is omitted without losing continuity.
- OM maintenance failures degrade safely instead of breaking the turn.

---

## Phase 1a: Hysteresis and Debounce

Add simple stability rules to avoid observe/reflect thrash:

- `observeEnter = observationThresholdTokens`
- `observeExit = floor(observationThresholdTokens * 0.7)`
- `reflectEnter = reflectionThresholdTokens`
- `reflectExit = floor(reflectionThresholdTokens * 0.75)`
- do not require another observe/reflect until the relevant metric falls below the exit threshold and rises again

Benefit:
- more stable OM behavior
- fewer redundant maintenance calls

Complexity:
- low; no new storage model required

---

## Phase 1b: Failure Fallback Policy

Add safe degradation when OM maintenance fails:

- after one failed `om.observe` / `om.reflect`, retry once on the next loop iteration
- after two consecutive failures, skip pruning for that turn and pass through a larger raw tail
- surface failure counts in `om.status`

Benefit:
- avoids “memory maintenance broke my turn” failure modes

Complexity:
- low; mostly control-flow and counters

---

## Phase 1c: Task Stability Rules

Make `currentTask` less twitchy:

- only replace `currentTask` when the new task clearly supersedes the old one
- preserve the old task when the delta is merely a substep or tool execution detail
- clear `suggestedResponse` more aggressively than `currentTask`

Benefit:
- less task churn
- more consistent continuation behavior

Complexity:
- low; mostly prompt and merge-policy tuning

---

## Phase 1d: Better Tool-Outcome Digestion

Tighten what enters OM from tool activity:

- prefer decisions, errors, artifact paths, test outcomes, and next-step implications
- de-emphasize raw logs and repetitive stdout
- keep tool output truncation, but improve the observer prompt so summaries are outcome-focused

Benefit:
- more useful observations
- less context rot from noisy tool logs

Complexity:
- low; primarily prompt/policy work

---

## Phase 1e: Forced Maintenance Guard

Add a light version of OM backpressure:

- define a hard overdue condition, such as:
  - unobserved buffer exceeds `1.5 * observationThresholdTokens`, or
  - OM block exceeds `1.25 * reflectionThresholdTokens`, or
  - OM maintenance was deferred for `N` consecutive turns
- when hard overdue, require maintenance before any user-facing answer

Benefit:
- recovers some of full OM’s `blockAfter` safety value without background jobs

Complexity:
- low-medium; requires a few more policy flags but no async architecture

---

## What This Still Does Not Include

Compared to full Mastra-style OM, v2 still omits:

- background observer / reflector runs
- async observation buffering
- activation markers for precomputed observation chunks
- scheduler-driven reflection work
- richer multi-record OM storage beyond the single active state

Those are the main remaining steps from `mini-B` to full `B`.

---

## Outstanding Decisions To Finalize

These should be clarified before implementation starts to reduce rework:

1. **Cursor authority**
   - prefer `messageID` cursor when available, with timestamp fallback
   - define exactly how pruning behaves if IDs are missing or reordered

2. **Assistant-output capture source**
   - choose whether finalized assistant text comes only from `event` subscriptions or whether some parts should also be reconstructed from stored messages

3. **Observe-vs-reflect ordering**
   - locked default is “observe first, reflect second if still needed”
   - confirm this is acceptable for all target models

4. **Pruning floor**
   - define the minimum guaranteed raw tail, such as:
     - latest user message
     - latest assistant reply
     - latest tool result group

5. **Maintenance-instruction strength**
   - decide how forcefully the system prompt tells the model to call `om.observe` / `om.reflect`
   - define fallback behavior if the model ignores the instruction

6. **State durability**
   - confirm JSON + atomic rename for Phase 1
   - clarify whether in-memory cache is authoritative or disk reload wins after errors

7. **Tool privacy policy**
   - define whether `om.export` redacts any content by default
   - confirm whether `om.forget` wipes only active OM state or also diagnostic stats

8. **Config surface**
   - confirm env vars only vs env vars plus project/global JSON config files

---

## Implementation Checklist (Recommended Defaults)

Use these defaults unless implementation findings force a change:

1. **Cursor authority**
   - Default: use `messageID` as the primary pruning cursor, with `atMs` fallback only when IDs are unavailable.
   - Why: ID-based pruning is more deterministic and less fragile than timestamp-only pruning.
   - Tradeoff: requires confidence that observed items can be mapped back to prompt-visible messages.
   - Mastra comparison: consistent with Mastra’s explicit per-thread OM cursor semantics (`lastObservedAt` plus dedicated OM metadata), though this plan prefers message IDs when possible.

2. **Assistant-output capture source**
   - Default: use finalized assistant text from `event` subscriptions as the primary source; fall back to reconstructed stored messages only for recovery/debug paths.
   - Why: event-driven capture is simpler and keeps OM close to the live turn boundary.
   - Tradeoff: depends on event completeness; reconstruction is more robust but adds more code and ambiguity.
   - Mastra comparison: Mastra’s processor model naturally sees the finalized pipeline state; this plugin approximation should prefer the nearest equivalent live signal.

3. **Observe-vs-reflect ordering**
   - Default: if both thresholds are exceeded, run `om.observe` first, then `om.reflect` on the next loop iteration.
   - Why: fresh unobserved deltas should not be lost or delayed behind compression work.
   - Tradeoff: may temporarily keep OM oversized for one extra loop.
   - Mastra comparison: compatible with Mastra’s staged model, where fresh observation and later reflection are distinct concerns.

4. **Pruning floor**
   - Default: always keep at least:
     - the latest user message
     - the latest assistant reply
     - the latest contiguous tool-result group associated with the current turn
   - Why: this preserves immediate conversational grounding even when OM is healthy.
   - Tradeoff: prompt size is slightly less aggressively minimized.
   - Mastra comparison: aligned with the spirit of preserving local continuity while older material moves into OM.

5. **Maintenance-instruction strength**
   - Default: inject an explicit system rule such as “Before answering, call `om.observe`/`om.reflect` if required.” If ignored once, restate the requirement on the next loop and mark the failure.
   - Why: strong enough to be reliable without overcomplicating enforcement.
   - Tradeoff: still depends on model compliance; stronger enforcement may require architecture changes.
   - Mastra comparison: weaker than Mastra’s built-in processor model, where memory maintenance is not delegated back to model discretion in the same way.

6. **State durability**
   - Default: JSON files with atomic rename for Phase 1, plus an in-memory cache that is refreshed from disk on startup and after write/read failures.
   - Why: fastest path with acceptable safety for a plugin-first rollout.
   - Tradeoff: less queryable and less concurrency-friendly than SQLite.
   - Mastra comparison: simpler than Mastra’s dedicated storage abstractions, but sufficient for a synchronous local-first Phase 1.

7. **Tool privacy policy**
   - Default:
     - `om.export` exports full OM content only when explicitly requested
     - `om.forget` clears active OM state and diagnostics for that session
   - Why: matches user intent cleanly and keeps privacy semantics easy to explain.
   - Tradeoff: wiping diagnostics reduces postmortem data for debugging.
   - Mastra comparison: implementation-specific; Mastra’s code does not force this exact policy, so clarity matters more than parity here.

8. **Config surface**
   - Default: support env vars first, plus optional global/project JSON config files for overrides.
   - Why: env vars are easy for testing, while JSON config is better for durable local tuning.
   - Tradeoff: two config surfaces add precedence rules that must be documented.
   - Mastra comparison: not a direct Mastra concern; this is an OpenCode plugin ergonomics choice.

---

## Recommendation

Implement **Core Mini-B** first, then add:

1. `Phase 1a` Hysteresis and Debounce
2. `Phase 1b` Failure Fallback Policy
3. `Phase 1c` Task Stability Rules
4. `Phase 1d` Better Tool-Outcome Digestion
5. `Phase 1e` Forced Maintenance Guard

That sequence preserves the current architectural boundary while making the system noticeably more OM-like, safer, and more stable without committing to full async/background OM.
