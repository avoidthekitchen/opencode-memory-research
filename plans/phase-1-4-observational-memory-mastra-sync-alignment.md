# Phase 1–4 Implementation Plan: Synchronous Mastra-Alignment for OpenCode Observational Memory

Date: 2026-03-04  
Source research: `research/opencode-mastra-memory.md`  
Related: `plans/phase-1-2-observational-memory-alignment.md`, `plans/phase-1-1-observational-memory-llm-extraction.md`  

## Summary

Goal: bring the project-local OpenCode observational-memory (OM) plugin closer to **Mastra’s implemented OM behavior** while explicitly staying **synchronous-only** (no async buffering / activation workers).

High-impact deltas (from current plugin vs Mastra):

1) **Pruning semantics**: Mastra OM’s core value is that once content is observed, it stops occupying the Actor’s context window. The plugin currently prunes only when over a raw-message budget, so it can inject `<observations>` while also leaving already-observed transcript in-context.

2) **Actor injection contract**: Mastra injects a stronger “observations context prompt” + detailed interpretation rules and a long continuation reminder; the plugin currently injects only `<observations>` plus a short reminder.

3) **Observer input formatting**: Mastra has a specific message formatting contract (timestamps, separators, tool call/result representation). The plugin uses a different per-turn grouping format.

Non-goal: implement Mastra’s async buffering (`bufferTokens`, `bufferActivation`, `blockAfter`) and activation markers. This plan replaces those benefits with deterministic synchronous rules (prune aggressively + retain a bounded recent tail).

## Implementation TODO Status (Master Checklist)

- [ ] Phase 1: Make pruning Mastra-like (drop observed history, keep bounded tail)
- [ ] Phase 2: Make Actor injection Mastra-like (context prompt + instructions + continuation hint, optional relative-time annotations)
- [ ] Phase 3: Make Observer input formatting Mastra-like (message formatting + tool call/result encoding)
- [ ] Phase 4: Close remaining behavioral gaps (config parity + optional scope mapping) without async buffering
- [ ] Run `node --experimental-strip-types scripts/smoke-om-plugin.mjs` after each phase

Status: planned (do not implement until explicitly approved).

## Baseline (Pinned)

This plan assumes the same analysis baseline as the main research doc:

- OpenCode: `anomalyco/opencode@78069369e2253c9788c09b7a71478d140c9741f2` (branch `dev` at time of analysis)
- Mastra: `mastra-ai/mastra@23b43ddd0e3db05dee828c2733faa2496b7b0319` (branch `main` at time of analysis)

Key Mastra code pointers:

- Defaults + OM processor: `repos/mastra/packages/memory/src/processors/observational-memory/observational-memory.ts`
- Observer formatting + extraction rules: `repos/mastra/packages/memory/src/processors/observational-memory/observer-agent.ts`
- Reflector prompt + compression validation: `repos/mastra/packages/memory/src/processors/observational-memory/reflector-agent.ts`

OpenCode plugin pointer:

- OM plugin prototype: `.opencode/plugins/observational-memory.ts`

## Terminology (Consistent With Mastra)

- **Actor**: the primary model call producing the user-visible assistant response.
- **Observer**: extraction step that converts recent transcript into structured observations.
- **Reflector**: rewrite/compress step that consolidates observations when they grow too large.
- **Observations**: durable memory injected into context; not user-visible.

## Phase 1 — Pruning Semantics (Synchronous, Mastra-like)

### Why (Impact)

This is the single biggest behavior gap: Mastra’s OM keeps context small by ensuring already-observed history is not continuously re-sent to the Actor.

### Recommendation (Default)

Make pruning **state-driven**, not “only when the prompt is too large”:

- If durable `<observations>` exist and a `lastObserved` cursor is present, prune observed history every turn (unless maintenance is required/deferred).
- Always retain a bounded “unobserved tail” of recent raw turns for continuity.

### Operational Spec

**Inputs**

- `state.lastObserved.turnAnchorMessageID` (the last fully observed user anchor)
- `state.memory.observations` (non-empty)
- `RECENT_USER_PROTECTION` (current “keep last N user turns” minimum)

**Algorithm (synchronous-only)**

1) If maintenance is required (`om_observe` / `om_reflect`) or deferred, do not prune.
2) If there is no durable observations block or no lastObserved cursor, do not prune.
3) Find the index of `lastObserved.turnAnchorMessageID` in the user-anchor list.
4) Compute `tailUserTurns = max(RECENT_USER_PROTECTION, configuredTailUserTurns)` (new config).
5) Prune **all messages older than**:
   - the last observed anchor, **but**
   - never prune within the most recent `tailUserTurns` user anchors.

**Continuation hint**

- If pruning occurred (older messages removed), inject a continuation hint system reminder.

### Alternatives (Explicit)

- **Alternative A (token-tail retention)**: retain a token budget of raw transcript rather than N user anchors.
  - Pros: more precise across very long user messages.
  - Cons: more token accounting complexity; more model-dependent.

- **Alternative B (keep current behavior)**: prune only when prompt exceeds `rawMessageBudgetTokens`.
  - Pros: simplest; reduces “sudden” pruning on short prompts.
  - Cons: often duplicates content (observations + already-observed raw transcript), undermining OM’s core value.

### Phase 1 TODO Checklist

- [ ] Add a config knob for “tail retention” (user turns or tokens) distinct from `rawMessageBudgetTokens`
- [ ] Change pruning so observed history is pruned whenever OM is “ready”, not only when over budget
- [ ] Ensure pruning stays disabled while maintenance is required/deferred
- [ ] Ensure continuation hint is injected only when pruning actually removed older context
- [ ] Update `om_status` to report tail retention settings + effective cutoff

## Phase 2 — Actor Injection Contract (Mastra-like)

### Why (Impact)

Mastra’s OM is not only the data format; it also includes **how the Actor is instructed** to interpret observations and continue naturally after pruning.

### Recommendation (Default)

Inject Mastra-equivalent context framing in the system prompt whenever OM is active:

- A preamble like Mastra’s `OBSERVATION_CONTEXT_PROMPT`
- The `<observations>...</observations>` block
- Mastra’s `OBSERVATION_CONTEXT_INSTRUCTIONS` guidance
- Mastra’s long continuation hint (when pruning removed earlier transcript)

Additionally (optional but Mastra-aligned):

- **Relative-time annotations** for `Date:` headers and inline `(meaning/estimated ...)` dates at injection time, based on “now”.
  - Important: this should be a presentation-layer transformation only; avoid mutating the stored durable observations.

### Operational Spec

**Stored state remains**

- durable observations (date-grouped)
- optional `<current-task>` + `<suggested-response>`

**Injected system message becomes**

- `OBSERVATION_CONTEXT_PROMPT` + `<observations>` + `OBSERVATION_CONTEXT_INSTRUCTIONS`
- optionally `<current-task>` and `<suggested-response>` (when present)

### Phase 2 TODO Checklist

- [ ] Replace/extend the OM system injection to match Mastra's context prompt + instructions
- [ ] Replace/extend the continuation hint to match Mastra's `OBSERVATION_CONTINUATION_HINT`
- [ ] Add optional relative-time annotation at injection-time (no mutation of stored durable memory)
- [ ] Ensure task/suggested response injection ordering matches intended priority (task hints should stay visible even when maintenance is required)
- [ ] Persist durable observations untrimmed (except hard safety cap); apply token optimization and optional temporal annotations only when injecting into Actor context (do not compress/trim at write time in merge/reflect paths)

## Phase 3 — Observer Input Formatting (Mastra-like)

### Why (Impact)

The Observer’s extraction quality depends heavily on consistent, information-rich message formatting (timestamps, role framing, tool call/result encoding).

### Recommendation (Default)

Move the plugin’s “new history to observe” formatting closer to Mastra’s `formatMessagesForObserver(...)` contract:

- `**Role (timestamp):**` headers
- `---` separators between messages
- include tool call args + tool results when available
- truncate very large tool outputs with “truncated N characters” marker (Mastra style)

### Constraints / Gaps (Call Out)

OpenCode’s plugin hooks typically capture:

- user message text (`chat.message`)
- tool results (`tool.execute.after`)
- assistant output text (via session fetch in `message.updated`)

Depending on OpenCode internals, the plugin may not have access to *tool invocation args* in the same fidelity Mastra gets from message parts. If args cannot be captured, Phase 3 should still:

- standardize formatting
- clearly label tool results
- keep truncation behavior stable

### Phase 3 TODO Checklist

- [ ] Update “new history to observe” formatting to Mastra-like separators and timestamps
- [ ] Include tool call and tool result encoding when available (or document limitations clearly)
- [ ] Match truncation markers to Mastra conventions for long content
- [ ] Validate observer/reflector sanitation still works with the new formatting

## Phase 4 — Close Remaining Gaps (Still Synchronous)

### Goal

Improve configurability and parity with Mastra’s implemented knobs without adding async buffering.

### Recommended items (in order)

1) **Config parity for thresholds**
   - Add Mastra-like “threshold range” support (min/max) so thresholds can adapt to available observation space.
   - Optional: Mastra’s `shareTokenBudget` concept, implemented synchronously.

2) **Scope mapping (explicitly not 1:1)**
   - Mastra supports `scope: 'thread'|'resource'`.
   - OpenCode plugin currently behaves session-scoped; define how (or if) a “resource scope” maps to OpenCode concepts (project id, worktree, etc.).
   - Keep this behind a config flag; do not silently change scope behavior.

3) **Mastra-like “relative time” policy improvements**
   - Ensure injected relative-time annotations use the user’s locale/timezone consistently.

### Phase 4 TODO Checklist

- [ ] Add threshold-range config (`{min,max}`) support (synchronous)
- [ ] Add optional `shareTokenBudget` equivalent (synchronous), with clear guardrails
- [ ] Define + document scope mapping options (`session`, `project`, optional `global`)
- [ ] Extend `om_status` to report resolved thresholds + scope mode + derived budgets

## Verification (Per Phase)

This repository has no repo-wide test system; validation for OM changes should use the existing smoke script:

- `node --experimental-strip-types scripts/smoke-om-plugin.mjs`
- Optionally: `node --experimental-strip-types scripts/smoke-om-plugin.mjs --opencode` (if `bun` is available and `repos/opencode` is present)

## Open Questions

- What is the safest “resource scope” analogue in OpenCode: project id, worktree path, git root, or an explicit user-provided key?
- Should “tail retention” be counted in user anchors, raw tokens, or both?
- Should relative-time annotations be enabled by default (token cost) or opt-in (clarity)?

