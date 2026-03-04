# Phase 1.3: Observational Memory Token Accounting Accuracy

Date: 2026-03-03
Source research: `research/opencode-mastra-memory-divergence.md`
Builds on: `plans/phase-1-observational-memory-v3.md`, `plans/phase-1-2-observational-memory-alignment.md`

## Summary

The current plugin uses a rough token heuristic:

- string token estimate: `ceil(chars / 4)`
- prompt pruning estimate: `estimateTokens(JSON.stringify(messages))`

That is good enough for a prototype, but it is not reliable for threshold decisions in tool-heavy and code-heavy sessions.

Phase 1.3 upgrades token accounting so OM decisions are based on the content that is actually sent to the model after OpenCode prompt transforms.

Locked default:

- count the transformed prompt-visible messages, not raw stored message objects
- keep the existing synchronous `om_observe` / `om_reflect` architecture
- treat Mastra-style `tiktoken` counting as the accuracy baseline, adapted to OpenCode's message schema

This phase is intentionally split into:

1. a first pass that captures most of the accuracy benefit without architectural changes
2. a final 10-15% accuracy pass that closes the remaining gap caused by provider/model serialization details

## Implementation Status

First-pass implementation status in this repo:

- [x] Add a plugin-local `TokenCounter` under `.opencode/plugins/` using `js-tiktoken/lite` with `o200k_base`.
- [x] Replace heuristic OM state/accounting writes with tokenized counts for buffer entries, durable memory, observe input, and trimming targets.
- [x] Replace pruning's `JSON.stringify(messages)` estimate with transformed-message counting that ignores hidden metadata and non-visible parts.
- [x] Include plugin-injected OM/task/maintenance blocks in token diagnostics and compute durable memory size from the injected OM block shape.
- [x] Lazily recompute persisted token estimates on load/mutation without introducing a one-shot migration.
- [x] Extend the focused smoke script with token-accounting checks and run the plugin-local smoke validation successfully on March 3, 2026.
- [x] Run the optional full `--opencode` smoke path cleanly. On March 3, 2026 this passed after updating the smoke launcher to execute from `repos/opencode/packages/opencode`, which makes Bun use the package-local Solid JSX config instead of the workspace root config.

## Verification Status

- [x] Focused plugin smoke validation passed via `node --experimental-strip-types scripts/smoke-om-plugin.mjs` on March 3, 2026.
- [x] OpenCode-backed smoke validation passed via `node --experimental-strip-types scripts/smoke-om-plugin.mjs --opencode` on March 3, 2026.
- [x] The smoke coverage exercises tokenized comparisons for prose, code, JSON/tool payloads, stack traces, hidden metadata exclusion, and prompt-visible message counting.

---

## Goals

1. Replace character-based estimates with tokenized counts for OM thresholds and pruning.
2. Count only content that survives into the final model input after `experimental.chat.messages.transform` and related pruning/injection steps.
3. Preserve current plugin behavior and storage shape unless token accounting itself requires a local refactor.
4. Make threshold decisions stable enough that observe/reflect/prune triggers stop drifting in code-heavy sessions.

## Non-Goals

- No background observer or reflector agents.
- No async buffering adoption in this phase.
- No attempt to make counts perfectly exact for every provider on the first pass.
- No OpenCode core changes unless later validation proves the plugin lacks access to the final prompt shape it needs.

---

## Current Divergence

Current plugin behavior in `.opencode/plugins/observational-memory.ts`:

- `estimateTokens()` is `ceil(text.length / 4)`
- observation buffer items store only heuristic token estimates
- reflection thresholds use heuristic OM size
- pruning uses `estimateTokens(JSON.stringify(messages))`

Mastra baseline behavior in `repos/mastra/packages/memory/src/processors/observational-memory/token-counter.ts`:

- uses `js-tiktoken` with `o200k_base`
- counts text with actual tokenization
- accounts for per-message and per-conversation overhead
- counts tool calls and tool results explicitly
- skips parts that are not sent to the model

The most important design difference for this repo:

- Mastra counts the model-facing content representation
- the plugin currently counts a developer-friendly approximation of local objects

---

## Locked Decisions

- **Counting boundary:** the source of truth is the final prompt-visible message list after message transforms and OM pruning decisions are applied.
- **Fallback encoding:** first pass uses `js-tiktoken` with `o200k_base`, matching Mastra's current baseline.
- **Injection accounting:** OM system blocks and continuation hints added by the plugin must be included in token counts when they are actually injected.
- **Non-model parts:** ignore parts that are not sent to the model.
- **Migration strategy:** replace heuristic reads first, then decide whether persisted token estimates should be recomputed lazily or migrated eagerly.

---

## First Pass

## Outcome

Ship a materially better token counter without changing the plugin's architecture or maintenance model.

## Scope

- Add a local `TokenCounter` module for OpenCode plugin use.
- Replace `estimateTokens()` threshold decisions with tokenized counts.
- Count final transformed messages for pruning decisions.
- Count OM memory blocks as strings using the same tokenizer.
- Keep provider/model selection fixed to one default encoding for now.

## Implementation Details

### 1. Add a plugin-local token counter

Target:

- new helper under `.opencode/plugins/` such as `token-counter.ts`

Behavior:

- use `js-tiktoken/lite`
- use `o200k_base`
- expose:
  - `countString(text: string): number`
  - `countMessage(message): number`
  - `countMessages(messages): number`

Adaptation requirements:

- handle OpenCode message parts, not Mastra `MastraDBMessage`
- count text parts that are actually model-visible
- count tool-call and tool-result payloads when they are model-visible
- skip synthetic OM metadata and any parts known to be excluded from model context
- include a practical message and conversation overhead similar to Mastra

### 2. Replace heuristic threshold accounting

Update the plugin so the following stop using `ceil(chars / 4)`:

- buffer item token estimates
- `state.buffer.tokenEstimateTotal`
- `state.memory.tokenEstimate`
- observe-input token estimate
- trimming logic that uses observation token targets

Implementation rule:

- if a value is persisted as a token estimate, compute it from the new token counter at write time

### 3. Count the final prompt-visible messages for pruning

Current weak path:

- `pruneMessages()` estimates from `JSON.stringify(messages)`

Replace with:

- count the actual transformed message list that will be sent to the model at that stage
- use the token counter against message parts, not serialized JSON

Important constraint:

- do not count hidden local metadata that never reaches the model

### 4. Include plugin-injected context when present

When OM injects:

- `<observations>`
- `<current-task>`
- `<suggested-response>`
- continuation hints

their token cost must be measurable with the same counter.

First-pass rule:

- count these as strings when computing `state.memory.tokenEstimate`
- optionally expose their token totals in `om_status` for debugging

### 5. Add lazy recomputation for old state

Existing sessions already persist heuristic token totals.

First-pass default:

- on load, preserve old data shape
- on first mutation of `buffer` or `memory`, recompute token totals with the new counter
- avoid a one-shot migration step unless required

## Verification

1. Add focused checks comparing old heuristic counts vs new tokenized counts for:
   - plain prose
   - code blocks
   - JSON/tool outputs
   - file paths and stack traces
2. Verify observe threshold decisions remain stable across repeated runs of the same transcript.
3. Verify pruning decisions are based on transformed messages, not raw object size.
4. Run the existing OM smoke script and confirm no regressions in core maintenance flow.

## Expected Result

This first pass should deliver most of the practical win:

- observe and reflect trigger closer to real context use
- pruning decisions stop drifting on code-heavy turns
- token totals become comparable to Mastra's counting philosophy

---

## Final 10-15% Accuracy

## Outcome

Close the remaining gap between "good tokenized approximation" and "model/provider-accurate accounting."

## Scope

- model-aware or provider-aware token counting
- exact handling of any OpenCode-specific serialization quirks
- end-to-end validation against the truly final outbound prompt shape

## Implementation Details

### 1. Make counting aware of the active model where possible

Current first-pass limitation:

- one encoding for all models

Hardening work:

- inspect the active OpenCode model ID at transform time
- map known model families to the best available tokenizer
- keep `o200k_base` as fallback when no better match exists

This matters most when:

- non-OpenAI-compatible tokenization differs materially
- prompt cost is close to threshold boundaries

### 2. Validate exact model-visible serialization

Open question after first pass:

- are plugin hooks seeing the final message objects exactly as the model sees them, or a near-final intermediate representation?

Hardening work:

- confirm whether `experimental.chat.messages.transform` receives the last model-facing shape
- if not, add a narrow adapter that mirrors the final serializer closely enough for counting

This is the main source of the remaining 10-15% uncertainty.

### 3. Tighten part-by-part inclusion rules

First pass will likely use conservative rules.

Hardening work:

- enumerate every part type that can appear in OpenCode chat messages
- explicitly classify each part as:
  - counted
  - skipped
  - counted conditionally
- document why each rule matches actual model delivery

### 4. Account for tool encoding more precisely

Mastra already compensates for some `JSON.stringify()` structural overhead when approximating native tool encoding.

Hardening work for the plugin:

- measure whether OpenCode tool call/result parts are overcounted or undercounted under the first-pass adapter
- add calibrated offsets only if repeated evidence shows systematic error

### 5. Add parity-focused diagnostics

Extend `om_status` or a debug-only path to expose:

- transformed message token count
- injected OM token count
- raw buffer token count
- counted vs skipped part totals
- active tokenizer / fallback path

This is needed to debug residual threshold drift.

## Verification

1. Compare counted tokens against real provider/model usage when that data is available.
2. Capture several transcripts and verify threshold boundaries are within an acceptable error margin.
3. Stress test tool-heavy sessions, especially large JSON outputs, stack traces, and code diffs.
4. Confirm counts remain stable across the same transcript after reload and state restoration.

## Expected Result

After this pass, the plugin should be close enough to treat token counts as operationally trustworthy rather than merely directional.

---

## Risks

- OpenCode may not expose the exact final outbound message shape in plugin hooks.
- Different models may still diverge from `o200k_base` enough to matter near thresholds.
- Replacing persisted heuristic totals can create temporary threshold jumps in long-lived sessions.

## Mitigations

- keep `o200k_base` as the initial baseline and document it clearly
- lazily recompute persisted totals on mutation
- expose debug counters so threshold decisions can be explained and tuned

---

## Recommended Execution Order

1. Add the plugin-local token counter and adapter for OpenCode message parts.
2. Replace all internal heuristic token totals except pruning.
3. Replace pruning counts with transformed-message token counts.
4. Add debug visibility in `om_status`.
5. Validate first-pass behavior with the smoke script.
6. Only after that, pursue model-aware and serializer-aware hardening.

## Done Criteria

First pass is done when:

- no threshold decision depends on `ceil(chars / 4)`
- pruning no longer depends on `JSON.stringify(messages)`
- the plugin counts transformed, model-visible prompt content
- smoke validation passes

Final accuracy pass is done when:

- tokenizer selection is model-aware where practical
- counted parts match actual model-visible serialization rules
- remaining threshold drift is measured and judged acceptable
