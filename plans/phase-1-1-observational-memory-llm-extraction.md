# Phase 1.1 Implementation Plan: LLM-Driven Structured Observation/Reflection

Date: 2026-03-03  
Source research: `research/opencode-mastra-memory.md`  
Builds on: `plans/phase-1-observational-memory-v3.md` (Phase 1 Mini-B runnable prototype)  

## Summary

Phase 1 shipped a runnable observational-memory (OM) plugin, but `om_observe` and `om_reflect` are currently **deterministic local digest/compression passes** rather than model-driven extraction. This Phase 1.1 plan re-introduces **LLM-driven** observation and reflection to capture durable facts and actions with higher quality and Mastra-aligned structure.

Core intent:

- Keep the **Phase 1 architecture** (session-scoped OM, thresholds, pruning, single-writer lock, safe degradation).
- Change **what observe/reflect do**: replace heuristic summaries with **structured LLM extraction** and **LLM reflection (rewrite/compress)**.
- Preserve compatibility with OpenCode plugin constraints by implementing observation/reflection via the **tool loop** (model calls `om_observe` / `om_reflect`).

Non-goals (still out of scope in Phase 1.1):

- background observer / reflector agents
- async buffering / activation markers
- per-repo or cross-session OM
- semantic recall / embeddings / vector search

## Implementation TODO Status

- [x] Add `llm` mode config and keep deterministic mode as an explicit fallback option, not an automatic recovery path.
- [x] Replace `om_observe` tool args with structured observer output fields (`observations`, `currentTask`, `suggestedResponse`, optional cursor hint).
- [x] Replace `om_reflect` tool args with structured reflector output fields and optional compression retry level.
- [x] Add observer/reflection sanitization helpers for XML tag stripping, length caps, line dedupe, and degenerate-output rejection.
- [x] Add buffered-history formatting helpers for observe-required prompts using turn-grouped user/assistant/tool context.
- [x] Change maintenance flow so `ensureMemoryReady(...)` sets maintenance requirements instead of running deterministic observe/reflect when `mode=llm`.
- [x] Inject explicit observe/reflect system instructions and prompt payloads in `experimental.chat.system.transform`.
- [x] Optionally strengthen required tool descriptions through `tool.definition` on maintenance-required turns.
- [x] Keep `currentTask` and `suggestedResponse` injected whenever present, and explicitly clear stale values when omitted by a fresh observation result.
- [x] Keep pruning disabled while observe/reflect maintenance is required or deferred.
- [x] Preserve existing protected-tail pruning floor and `lastObserved.turnAnchorMessageID` cursor behavior once OM is current.
- [x] Update `om_status` to expose llm-mode maintenance state clearly enough to debug ignored or invalid maintenance calls.
- [x] Extend the smoke script expectations if needed for the new tool schemas and maintenance flow.
- [x] Run the minimum smoke validation with `node --experimental-strip-types scripts/smoke-om-plugin.mjs`.
- [x] Run an OpenCode-backed end-to-end smoke session where OM maintenance is required before the assistant answers.

## Verification Status

- [x] Focused plugin smoke validation passed via `node --experimental-strip-types scripts/smoke-om-plugin.mjs` on March 3, 2026.
- [x] OpenCode-backed end-to-end smoke validation passed via `node --experimental-strip-types scripts/smoke-om-plugin.mjs --opencode` on March 3, 2026.
- [x] LLM-mode maintenance flow is verified in repo code: maintenance is requested through system injection and tool-loop compliance rather than deterministic pre-run mutation.

Status: implemented and verified through focused and OpenCode-backed smoke coverage on March 3, 2026.

## Mastra Documentation References

- https://mastra.ai/docs/memory/observational-memory
- https://mastra.ai/research/observational-memory
- https://mastra.ai/blog/observational-memory

## Implementation Baseline (Pinned)

This plan is pinned to the same baseline as Phase 1 v3:

- OpenCode: `anomalyco/opencode@78069369e2253c9788c09b7a71478d140c9741f2` (local clone `repos/opencode` at detached `HEAD`)
- Mastra: `mastra-ai/mastra@23b43ddd0e3db05dee828c2733faa2496b7b0319` (local clone `repos/mastra` at detached `HEAD`)

If OpenCode’s plugin tool-loop semantics differ materially from this baseline, update this document before implementation.

## Reference: Mastra’s Observer/Reflector Contracts

Mastra’s Observer/Reflector are separate model calls with explicit extraction and output-format instructions.

Key implementation references (Mastra):

- Observer extraction rules (assertions vs questions, temporal anchoring, state updates): `repos/mastra/packages/memory/src/processors/observational-memory/observer-agent.ts:7`
- Observer output format (date-grouped, priority emoji bullets, plus `<current-task>` + `<suggested-response>`): `repos/mastra/packages/memory/src/processors/observational-memory/observer-agent.ts:233`
- Reflector system prompt (rewrite + compression, preserve everything important): `repos/mastra/packages/memory/src/processors/observational-memory/reflector-agent.ts:31`
- Observation/Reflection trigger thresholds and buffering concepts: `repos/mastra/packages/memory/src/processors/observational-memory/types.ts:53`

This Phase 1.1 plan intentionally **adopts the Observer’s output format and core extraction guidance**, but implements it through OpenCode’s tool loop rather than separate background model calls.

## Current Prototype Behavior (What Changes)

Current plugin (OpenCode) behavior (Phase 1 v3 implementation):

- Tools `om_observe` / `om_reflect` exist but accept only `force?: boolean` and do deterministic rewriting:
  - `om_observe`: summarizes buffered turn-groups into a single-line digest per turn-group: `.opencode/plugins/observational-memory.ts:126` and `.opencode/plugins/observational-memory.ts:464`
  - `om_reflect`: dedupes and keeps last N lines: `.opencode/plugins/observational-memory.ts:508`
- Memory maintenance is executed directly inside `ensureMemoryReady(...)` before LLM runs, not via model compliance: `.opencode/plugins/observational-memory.ts:418`

Phase 1.1 replaces the deterministic observe/reflect implementations with model-driven structured extraction and reflection.

## Phase 1.1 Design

### Scope and Trigger Point (unchanged)

- Scope: per-session OM only (no sharing).
- Trigger point: evaluate observe/reflect thresholds before each **outer assistant LLM invocation**.
- Ordering: observe first, then reflect if still needed (unchanged).
- Pruning rule: do not prune when maintenance is required or deferred (unchanged).

### What “LLM-Driven” Means in OpenCode

OpenCode plugin constraints mean Phase 1.1 should not attempt to call an external LLM directly from the plugin. Instead:

- When OM maintenance is required, the plugin injects an explicit system instruction and the relevant input (buffer or observations).
- The model calls `om_observe` / `om_reflect` and supplies structured output as tool arguments.
- On the next tool-loop model invocation, OM is injected and pruning can proceed (because maintenance is now current).

### Tool Contract Changes

#### `om_observe` (model-driven extraction)

Tool ID: `om_observe` (existing)

New args (replace `force`-only contract):

```ts
{
  observations: string,          // content for inside <observations>...</observations>, without tags
  currentTask?: string,          // content for <current-task>...</current-task>, without tags
  suggestedResponse?: string,    // content for <suggested-response>...</suggested-response>, without tags
  confirmObservedThrough?: string // optional turnAnchorMessageID for cursor sanity (best-effort)
}
```

Execution behavior:

- Validate/sanitize args (strip `<observations>` tags if the model included them anyway).
- Merge new observations with prior observations, then dedupe, then apply a bounded hybrid retention policy.
  - Default retention policy:
    - treat the Mastra-style date-grouped observation format as the primary trim unit
    - keep a soft token target of `floor(reflectionThresholdTokens * 0.75)` to avoid immediate observe-then-reflect thrash
    - trim the oldest date groups first until under the soft target
    - enforce a hard max-lines or max-chars ceiling as a backstop against pathological single-cycle growth
  - Rationale: preserves readable/date-grouped structure better than naive line slicing while still aligning retention to the actual reflection budget.
- Advance `lastObserved.turnAnchorMessageID` based on completed turn-groups, optionally cross-check `confirmObservedThrough` if present.
- Clear observed items from the buffer (keep any incomplete tail items that do not have an assistant completion yet).
- Set `memory.currentTask` and `memory.suggestedResponse` from args.
- Update token estimates and `updatedAtMs`.

#### `om_reflect` (model-driven rewrite/compression)

Tool ID: `om_reflect` (existing)

New args:

```ts
{
  observations: string,        // replacement condensed observations (no surrounding tags)
  currentTask?: string,
  suggestedResponse?: string,
  compressionLevel?: 0 | 1 | 2 | 3 // optional “retry with more compression” selector
}
```

Execution behavior:

- Replace `memory.observations` with `observations` (after sanitization/dedupe).
- Update token estimates and `updatedAtMs`.
- Increment reflection stats.

### Maintenance Prompting (What the Model Sees)

Phase 1.1 requires a new system injection path that provides explicit “observer/reflector” instructions plus the correct input material.

#### Observe-required system injection

When `observeRequired` is set:

- Inject a system reminder: “Before answering, call `om_observe`.”
- Inject the Observer extraction guidance adapted from Mastra:
  - distinguish user assertions vs questions
  - temporal anchoring
  - preserve specifics (names, numbers, code snippets where relevant)
  - avoid repetition; group repeated tool/file actions
- Inject the Observer output format (Mastra-aligned) for the `observations` string:
  - date-grouped sections
  - bullet items with priority emoji and 24-hour `(HH:MM)`
  - nested sub-bullets for grouped actions
- Provide the **input**:
  - `Previous observations` (if any) so the model can avoid repeating.
  - `New history to observe`: a bounded, turn-group formatted view of the buffered items being observed.

Buffer formatting recommendations:

- Use a compact, deterministic format similar to Mastra’s `formatMessagesForObserver(...)` but adapted to the plugin’s buffer items:
  - include local date + time per item (derived from `atMs`)
  - include `User:` / `Assistant:` / `Tool:` prefixes
  - group by turn anchor (turn-group)
- Keep tool outputs already truncated by Phase 1 (`toolOutputChars`) and additionally cap the observe input size to prevent prompt blowups.

#### Reflect-required system injection

When `reflectRequired` is set:

- Inject a system reminder: “Before answering, call `om_reflect`.”
- Provide the Reflector guidance adapted from Mastra:
  - reflections become the entire durable memory for earlier context
  - preserve dates/times, user assertions, critical decisions, and recent detail
  - compress older observations more aggressively than recent ones
- Provide the **input**:
  - the current `memory.observations` (and optionally the current task / suggested response).

### Output Parsing and Sanitization

Even though OpenCode tools accept JSON args, models will sometimes embed tags or formatting artifacts inside fields. Phase 1.1 should defensively sanitize:

- Strip surrounding `<observations>...</observations>` tags if present in `args.observations`.
- Strip `<current-task>` / `<suggested-response>` tags if present in those fields.
- Enforce per-line and total-length caps to protect against degeneration.
- Dedupe lines in an order-preserving way.

Degeneracy detection (recommended):

- Add a cheap repeated-window detector similar in spirit to Mastra’s `detectDegenerateRepetition(...)`:
  - if detected, reject the tool call with a short “degenerate output, retry with shorter output” message.

### Failure and Degradation Policy

Phase 1.1 introduces new failure modes (model ignores maintenance, invalid tool args, degenerate outputs). Policies:

- If maintenance is required but not performed, do not prune and do not inject OM for that invocation.
- Surface a minimal system reminder on the next invocation: “Earlier context could not be refreshed; prefer visible recent transcript.”
- Track counters:
  - `observeFailures`, `reflectFailures`
  - `maintenanceDeferredTurns`
- Allow manual user intervention tools (`om_status`, `om_export`, `om_forget`) to remain available.

### Config Surface (Phase 1.1)

Phase 1.1 should add an explicit mode toggle so deterministic behavior remains available:

- `OPENCODE_OM_MODE=llm|deterministic` (default: `llm`)

Optional (recommended) safety knobs:

- `OPENCODE_OM_MAX_OBSERVE_INPUT_CHARS`
- `OPENCODE_OM_MAX_OBSERVATIONS_CHARS`
- `OPENCODE_OM_MAX_TASK_CHARS`
- `OPENCODE_OM_MAX_SUGGESTED_RESPONSE_CHARS`

## Implementation Steps (Concrete)

This section is intentionally implementation-specific and references the current prototype file layout.

1. Update tool schemas and storage behavior:
   - Replace `force?: boolean` arg schemas for `om_observe` / `om_reflect` in `.opencode/plugins/observational-memory.ts`.
   - Implement validation/sanitization and state updates as described above.

2. Replace internal deterministic maintenance with tool-loop prompting:
   - In `.opencode/plugins/observational-memory.ts`, change `ensureMemoryReady(...)` to:
     - set flags (`observeRequired` / `reflectRequired`) and build system injection content
     - avoid calling `observe(...)` / `reflect(...)` directly in `ensureMemoryReady(...)` when mode is `llm`
   - Keep deterministic maintenance available when mode is `deterministic`.

3. Add “maintenance-required” system injection blocks:
   - In `.opencode/plugins/observational-memory.ts` `experimental.chat.system.transform`, when maintenance is required:
     - inject the observe/reflect instruction + input blocks described above
     - strengthen the required tool description via `tool.definition` as a turn-local reinforcement, while keeping the system instruction as the authoritative maintenance rule

4. Keep pruning correctness:
   - Ensure `experimental.chat.messages.transform` does not prune when `observeRequired` or `reflectRequired` is set.
   - Ensure pruning remains anchored to `lastObserved.turnAnchorMessageID` and the protected tail floor.

5. Add smoke verification:
   - Minimum: `node --experimental-strip-types scripts/smoke-om-plugin.mjs`
   - Manual: ask OpenCode to call `om_status`, then drive a tool-heavy session until `om_observe` is required.

## Success Criteria

- Observations contain durable, specific facts and actions (names, numbers, decisions, outcomes) rather than generic “User asked / Assistant did” summaries.
- Reflection reduces observation size while preserving key facts and recent detail.
- When maintenance is required, the model reliably calls `om_observe` / `om_reflect` before answering at least once per threshold crossing.
- Failures degrade safely: no pruning without refreshed OM, and the user experience remains coherent.

## Confirmed Decisions (2026-03-03)

- Observation format strictness:
  - Follow Mastra’s exact output format (date-grouped sections + priority emoji bullets + 24-hour `(HH:MM)`), as implemented in `repos/mastra/packages/memory/src/processors/observational-memory/observer-agent.ts:233`.

- “Durable facts” scope (Mastra-aligned):
  - Capture technical/coding-session specifics when they matter for continuity, including code snippets and detailed assistant explanations, per Mastra’s Observer extraction guidance and “CONVERSATION CONTEXT” rules in `repos/mastra/packages/memory/src/processors/observational-memory/observer-agent.ts:7`.
  - Priority assignment should follow Mastra’s rules of thumb (user messages are 🔴; tool results and learned information are often 🟡; promote to 🔴 when they are critical decisions/outcomes).

- Suggested response usage (Mastra-aligned):
  - Inject `<current-task>` and `<suggested-response>` into the Actor/system context whenever present (not only on maintenance turns), mirroring Mastra’s context injection path in `repos/mastra/packages/memory/src/processors/observational-memory/observational-memory.ts:2557`.
  - Clear `currentTask` / `suggestedResponse` explicitly when omitted in a new observation result to avoid stale hints (mirrors Mastra’s thread-metadata update behavior in `repos/mastra/packages/memory/src/processors/observational-memory/observational-memory.ts:5529`).

- Post-observe retention policy:
  - Use the hybrid retention policy described above: trim oldest date groups toward a soft token target, with a hard backstop ceiling.

- Maintenance prompting strength:
  - Use light dual prompting:
    - system instruction in `experimental.chat.system.transform` is the primary requirement
    - `tool.definition` strengthens only the currently required maintenance tool on that turn
  - Do not escalate to heavier prompt duplication unless real-session compliance proves insufficient.

- Failure enforcement:
  - If the model ignores required maintenance, do not fall back to deterministic summarization; strictly defer and keep raw context (no pruning) until maintenance completes.

- Privacy and exports:
  - `om_export` remains raw for debugging (no default redaction in Phase 1.1).
