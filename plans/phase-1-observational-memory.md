# Phase 1 Implementation Plan: Observational Memory (OpenCode Plugin, Per-Session)

Date: 2026-03-02  
Source research: `research/opencode-mastra-memory.md`

## Summary

Implement Mastra-style **Observational Memory (OM)** in OpenCode as a **plugin** that provides a “perceived infinite context” experience by:

- Maintaining a structured, bounded **observations log** for each OpenCode session (`sessionID` ≈ Mastra `threadId`).
- Proactively triggering **observation** and **reflection** based on thresholds (not only on overflow/compaction).
- Keeping the prompt small by **dropping older raw messages from the LLM context** once they are covered by observations, while leaving OpenCode’s persisted transcript intact.

This document now treats Phase 1 as a **spectrum of options**, from the lightest `Approach A+` upgrade to the current recommended “mini-B” design:
- **No background agents / scheduler buffering** anywhere on the Phase 1 spectrum.
- More OM-like points on the spectrum add threshold-driven observation/reflection and more aggressive prompt pruning.

---

## Phase 1 Spectrum

### Option 0: Approach A (compaction-upgrade only)

Use OpenCode compaction as the only observation trigger:
- Generate `<observations>`, `<current-task>`, and `<suggested-response>` during compaction.
- Persist and inject that OM block on later turns.
- Keep existing pruning/compaction behavior unchanged.

Why choose it:
- Smallest implementation and lowest risk.

What it misses:
- No incremental updates between compactions.
- Still feels overflow-driven rather than always-on.

### Option 1: Approach A+ (incremental OM-lite)

Keep compaction as the foundation, but add a small incremental merge path:
- Maintain a lightweight OM state (`observations`, `currentTask`, `suggestedResponse`, cursor, delta token estimate).
- Collect unobserved deltas from `chat.message` and `tool.execute.after`.
- Before each LLM call, if the delta is non-empty or crosses a small threshold, synchronously merge it into the OM block.
- Keep OpenCode’s existing pruning behavior for raw messages and tool outputs.

Why choose it:
- Captures the main UX win of “always-updating memory” with minimal new machinery.

What it misses:
- Does not proactively reshape the raw prompt beyond existing compaction/pruning.
- Observation/reflection are still a single merged behavior rather than separate phases.

### Option 2: Current recommended Phase 1 (“mini-B”)

Move one step closer to Mastra OM while staying synchronous:
- Maintain explicit OM state per session.
- Evaluate observation/reflection thresholds every turn.
- Use `om.observe` / `om.reflect` tools to update OM before answering when needed.
- Prune older observed raw messages from the prompt, keeping only a bounded unobserved tail plus continuation hint.

Why choose it:
- Delivers most of the behavioral benefits of true OM without background agents.

Cost:
- More moving parts than `A+` (state machine, internal tools, prompt-tail pruning).

### Decision matrix

| Option | Core idea | Complexity | UX gain | Prompt control | Latency impact |
| --- | --- | --- | --- | --- | --- |
| 0 — `A` | Compaction generates OM-style summary | Pro: smallest change surface. Con: tied to compaction flow. | Pro: better summaries after compaction. Con: no always-on continuity. | Pro: reuses current prompt behavior. Con: little control over raw history shape. | Pro: almost no extra per-turn work. Con: big updates arrive in bursts. |
| 1 — `A+` | Compaction plus incremental inline OM merge | Pro: modest incremental state/merge logic. Con: more moving parts than pure compaction. | Pro: memory feels more continuously updated. Con: still not full OM behavior. | Pro: injects fresher OM context each turn. Con: mostly relies on existing pruning. | Pro: bounded synchronous updates. Con: some turns pay inline merge cost. |
| 2 — “mini-B” | Threshold-driven observe/reflect plus prompt-tail pruning | Pro: most OM-like without background agents. Con: requires tools, thresholds, and a state machine. | Pro: strongest continuity for long tool-heavy sessions. Con: more implementation/debug effort. | Pro: explicit control over observed vs raw tail. Con: pruning logic is more complex. | Pro: keeps prompt size stable over time. Con: highest synchronous overhead in Phase 1. |

---

## Goals (Success Criteria)

1) **Continuity without manual management**
- Over long sessions with heavy tool output, the assistant continues seamlessly without the user needing to trigger compaction/summarization.

2) **Prompt stays bounded**
- The plugin ensures the LLM sees only:
  - a bounded set of most-recent unobserved messages, plus
  - an OM system block (`<observations>…</observations>` + `<current-task>` + optional `<suggested-response>`),
  - and a continuation hint when older messages are omitted.

3) **Mastra-aligned behavior (thread/session scope)**
- OM state is stored **per session** (Mastra OM is thread-scoped).
- Observation triggers when unobserved content exceeds an “observation” threshold.
- Reflection triggers when the observations block exceeds a “reflection” threshold.

4) **Local-first privacy**
- OM is stored locally on disk; no network services required.

---

## Non-Goals (Phase 1)

- Cross-session/per-repo semantic recall (embeddings/vector search).
- Long-lived “working memory” / user profile memory.
- Full Mastra async buffering (`bufferTokens`, `bufferActivation`, `blockAfter`) and background observer/reflector agents.
- UI polish (dedicated memory UI). Phase 1 focuses on behavior; UX can be iterative.

---

## Key Decisions (Locked)

- **Scope:** per-session OM (`sessionID`), because this matches Mastra thread-scoped OM most closely.
- **Trigger frequency:** evaluate OM thresholds **every turn** (pre-LLM call), not only during compaction.
- **Storage default:** **local-only** (see “Storage Options” for concrete recommendation).
- **Recommended point on the spectrum:** Option 2 (“mini-B”) is the default target for this plan; `A+` remains a valid fallback if we want a lower-risk first cut.

---

## References (Pinning)

- OpenCode commit (analysis baseline): `anomalyco/opencode@78069369e2253c9788c09b7a71478d140c9741f2`
- Mastra commit (analysis baseline): `mastra-ai/mastra@23b43ddd0e3db05dee828c2733faa2496b7b0319`
- Mastra OM defaults at this SHA (from `packages/memory/src/processors/observational-memory/observational-memory.ts`):
  - `observation.messageTokens = 30_000`
  - `reflection.observationTokens = 40_000`

Note: earlier docs/changelogs may mention other values; for Phase 1 implementation planning, treat **30k/40k** as the code defaults.

---

## Plugin Integration Points (OpenCode)

Use OpenCode’s plugin hooks (from `@opencode-ai/plugin`):

### Observe inputs
- `chat.message` — user messages + parts.
- `tool.execute.after` — tool outputs (title/output/metadata).
- `event` — subscribe to Bus events (e.g. `message.updated`, `message.part.updated`) for assistant outputs and streaming/tool part updates.

### Control prompt shape (critical)
- `experimental.chat.system.transform` — inject OM system context (observations/current-task).
- `experimental.chat.messages.transform` — drop older messages from the LLM context + insert continuation hint message(s).

### Provide tools (critical for synchronous OM updates)
- `tool` — register OM tools (observe/reflect/forget/export/debug).
- `tool.definition` — optionally strengthen tool descriptions when OM is “required this turn”.

---

## Phase 1 Architecture

### High-level flow (per OpenCode turn)

1) Plugin maintains an **OM state** for `sessionID`, updated incrementally as messages and tool outputs occur.
2) Before each LLM call:
   - If “needs observation”: instruct model to call `om.observe` tool first.
   - Else if “needs reflection”: instruct model to call `om.reflect` tool first.
   - Else: inject OM context and prune raw messages in the prompt (keep only unobserved tail).
3) After OM updates:
   - The next LLM step proceeds with a smaller prompt and the OM block injected.

This mirrors Mastra’s processor idea, but uses OpenCode’s tool-loop to avoid background agents.

### OM state machine (simplified)

State variables (per session):
- `cursor.lastObservedMessageId` (or `lastObservedAt` timestamp) for what’s already covered by observations.
- `buffer.unobservedItems[]` representing recent unobserved content (user messages, assistant responses, tool results).
- `buffer.unobservedTokenEstimate`
- `observations.active` (string or structured array)
- `observations.tokenEstimate`
- `currentTask` and optional `suggestedResponse`

Transitions:
- When `buffer.unobservedTokenEstimate >= observationThreshold` → **needsObserve = true**
- When `observations.tokenEstimate >= reflectionThreshold` → **needsReflect = true**

---

## Data Model (Plugin-Owned)

### On-disk layout (recommended)

Store per-session OM state outside the repo, using the same XDG conventions OpenCode uses:

- macOS/Linux:
  - State directory: `${XDG_STATE_HOME:-~/.local/state}/opencode`
  - Plugin directory: `${STATE}/plugins/observational-memory`
  - Per-session file: `${STATE}/plugins/observational-memory/sessions/<sessionID>.json`
- Windows:
  - Use `%LOCALAPPDATA%\\opencode\\state\\plugins\\observational-memory\\sessions\\<sessionID>.json`

Implementation detail: use atomic writes (`write temp -> fsync -> rename`) to avoid corruption.

### OM state schema (v1)

```ts
type OmStateV1 = {
  version: 1
  sessionID: string
  projectID?: string

  // Cursor: what the observations cover
  lastObserved: {
    messageID?: string        // best-effort cursor (preferred)
    atMs?: number             // fallback cursor if messageIDs are unreliable
  }

  // Unobserved buffer (what we’re about to turn into observations)
  buffer: {
    items: Array<{
      kind: "user" | "assistant" | "tool"
      id: string              // messageID or callID; best-effort identifier
      atMs: number
      text: string            // normalized text used for observation/reflection prompts
      tokenEstimate: number
    }>
    tokenEstimateTotal: number
  }

  // Active memory injected into the prompt
  memory: {
    observations: string      // canonical XML-ish block content (no surrounding tags)
    currentTask?: string
    suggestedResponse?: string
    tokenEstimate: number
    updatedAtMs: number
  }

  // Controls and debugging
  stats: {
    totalObservedItems: number
    totalReflections: number
  }

  // Used to avoid tool-loop thrash
  flags: {
    observeInProgress?: boolean
    reflectInProgress?: boolean
  }
}
```

Notes:
- `messageID` cursor is “best effort” because the plugin may not always see final IDs before observation triggers; keep `atMs` as a fallback.
- Store normalized text (already truncated/sanitized) in `buffer.items[]` so the tool prompts stay bounded.

---

## Token Estimation (Phase 1)

We need token estimates to decide when to observe/reflect and how aggressively to prune.

### Estimation rule
- Phase 1 uses a cheap heuristic: `tokens ≈ ceil(chars / 4)` for English-like text.

### What gets counted
- User text parts.
- Assistant text parts (finalized output; ignore streaming deltas once finalized).
- Tool outputs: include **title + first N chars** of output (default `N=2000`), because raw tool logs can dominate.

### What gets excluded
- Synthetic reminder parts injected by OpenCode (plan reminders, OM continuation hint).
- Attachments / binary content (file, image, pdf data URLs).
- OM tool traffic (`om.observe`, `om.reflect`, `om.forget`, etc.) is excluded from both buffering and prompt injection.

---

## Thresholds and Budgets

### Defaults (Mastra-aligned, but context-aware)

Mastra defaults are very large; to preserve the spirit while keeping OpenCode prompts stable across models, use:

- `observationThresholdTokens = min(30_000, floor(model.limit.context * 0.35))`
- `reflectionThresholdTokens = min(40_000, floor(model.limit.context * 0.50))`

Additionally define a “raw message budget” for what remains in the prompt after pruning:

- `rawMessageBudgetTokens = floor(model.limit.context * 0.25)`

Rationale:
- OM should cover most history; raw messages should be a bounded “recent tail”.

### Operator overrides (Phase 1 config)

Because OpenCode’s global config schema strips unknown keys, configure the plugin via:

1) Environment variables (highest priority), e.g.
   - `OPENCODE_OM_ENABLED=1`
   - `OPENCODE_OM_OBSERVE_TOKENS=12000`
   - `OPENCODE_OM_REFLECT_TOKENS=18000`
   - `OPENCODE_OM_RAW_BUDGET_TOKENS=6000`
   - `OPENCODE_OM_TOOL_OUTPUT_CHARS=2000`
2) Optional JSON config files read directly by the plugin:
   - Project: `<repo>/.opencode/observational-memory.json`
   - Global: `~/.config/opencode/observational-memory.json`

Config file format:
```json
{
  "enabled": true,
  "observeTokens": 12000,
  "reflectTokens": 18000,
  "rawBudgetTokens": 6000,
  "toolOutputChars": 2000
}
```

---

## Tools (Plugin-Provided)

### `om.observe` (called by the model)

Purpose: turn the unobserved buffer into structured memory.

Args schema (keep simple; plugin owns cursors):
```json
{
  "observations": "string (XML-ish content for <observations>…</observations> WITHOUT the tags)",
  "currentTask": "string (optional)",
  "suggestedResponse": "string (optional)"
}
```

Tool behavior:
- Reads current `buffer.items[]` from OM state.
- Replaces (or appends to) `memory.observations` in a bounded way:
  - Prefer append for recent history, but if `memory.observations` grows too fast, allow the observer to output a full replacement.
- Sets `lastObserved` cursor to the last buffered item.
- Clears the buffer and sets `memory.updatedAtMs = now`.

### `om.reflect` (called by the model)

Purpose: compress/rewrite the observations log when it gets too large.

Args schema:
```json
{
  "observations": "string (new condensed observations content; replaces prior)",
  "currentTask": "string (optional)",
  "suggestedResponse": "string (optional)"
}
```

Tool behavior:
- Replaces `memory.observations` with the condensed output.
- Updates `memory.tokenEstimate`.
- Increments `stats.totalReflections`.

### User-facing utilities (Phase 1)

- `om.status` → show thresholds, token estimates, lastObserved cursor.
- `om.export` → write a human-readable export file to a chosen path.
- `om.forget` → delete session OM state (and optionally wipe on-disk file).

---

## Prompt Injection Format (Mastra-inspired)

### System injection (every turn)

Injected via `experimental.chat.system.transform`:

```
<observations>
...memory.observations...
</observations>

<current-task>
...memory.currentTask...
</current-task>

<suggested-response>
...memory.suggestedResponse...
</suggested-response>

Rules:
- Treat observations as the authoritative memory of earlier messages not present.
- Use the most recent observation when conflicts exist.
- Do not mention “observations” or “memory system” to the user.
```

### Continuation hint (only when older messages are omitted)

Injected as a **synthetic user message** in `experimental.chat.messages.transform` right after the truncation boundary:

```
<system-reminder>
This is not a new conversation. Earlier context was moved into your observations.
Continue naturally without referencing the memory system.
</system-reminder>
```

---

## How the Plugin Achieves “Approach B Benefits” Without Background Agents

This section describes **Option 2** from the spectrum above. If we instead choose `A+`, the same hooks still apply, but with a simpler “inline merge OM state” path and without explicit `om.observe` / `om.reflect` tool orchestration or raw-tail pruning.

### 1) “Check every turn” thresholds

On every LLM call, the plugin:
- computes/reads `buffer.unobservedTokenEstimateTotal`
- computes/reads `memory.tokenEstimate`
- compares against thresholds derived from `input.model.limit.context`

### 2) Synchronous observe/reflect via tool loop

When `needsObserve` or `needsReflect`, the plugin adds a system instruction such as:
- “Before responding, call `om.observe` (or `om.reflect`). Do not answer the user until it succeeds.”

This is reliable in practice because OpenCode runs the LLM in a tool-capable loop; after the tool returns, the model continues.

### 3) Proactive prompt shrinking via message transforms

After successful observation (cursor advanced), subsequent LLM calls omit older raw messages by:
- Dropping all message/part content **at or before** the `lastObserved` cursor, and
- Keeping only the “unobserved tail” (bounded by `rawMessageBudgetTokens`),
- While always injecting the OM system block.

This produces the “infinite context” feel: the user doesn’t need to manage compaction; the plugin continuously maintains a stable memory surface.

---

## Detailed Hook Implementation Plan

### A) Initialization

1) Create plugin (preferred as a local file plugin during iteration):
   - Location (project): `.opencode/plugins/observational-memory.ts`
   - Or location (global): `~/.config/opencode/plugins/observational-memory.ts`
2) Plugin boot:
   - Create plugin state dir in XDG state path.
   - Initialize in-memory cache: `Map<sessionID, OmStateV1>`.

### B) Buffer collection

1) `chat.message`:
   - Normalize user message parts into buffer items.
2) `tool.execute.after`:
   - Normalize tool output into buffer items (truncate output).
3) `event`:
   - Watch for `message.updated` where `info.role === "assistant"` and message is completed.
   - Add assistant text parts to the buffer.
   - Watch `message.part.updated` for completed tool parts if needed (optional if `tool.execute.after` is sufficient).

Normalization rules:
- Extract only text-bearing parts.
- Apply truncation to tool outputs.
- Compute token estimates and increment buffer totals.

### C) Decide observe/reflect on each LLM call

Use `experimental.chat.system.transform` (has `sessionID` + `model.limit.context`) to:

1) Load OM state for `sessionID`.
2) Compute thresholds and budgets for this model.
3) If `needsReflect`:
   - Inject “call `om.reflect` before responding” instruction.
4) Else if `needsObserve`:
   - Inject “call `om.observe` before responding” instruction.
5) Else:
   - Inject OM system block normally.

### D) Prune messages before each LLM call

Use `experimental.chat.messages.transform` to:

1) Identify `sessionID` from the last user message in `output.messages`.
2) Load OM state.
3) Remove OM tool traffic messages/parts from the prompt view (filter by tool name).
4) If OM exists and `lastObserved` cursor is set and we are NOT in “needsObserve/needsReflect”:
   - Drop messages older than the cursor.
   - Further trim oldest remaining messages until within `rawMessageBudgetTokens`.
   - Insert continuation hint synthetic user message at the cut boundary.
5) If we are in “needsObserve/needsReflect”:
   - Do **not** prune; the model needs full recent context to produce correct OM updates.

### E) Tools implementation

Implement tools under `hooks.tool`:
- `om.observe`
- `om.reflect`
- `om.status`
- `om.export`
- `om.forget`

Implement `tool.definition` to:
- Emphasize “required now” behavior when `needsObserve/needsReflect`.
- Mark tools as internal/maintenance in descriptions to discourage casual user invocation.

---

## Testing Plan (Phase 1)

### Unit tests (plugin-local)

1) Token estimation:
- Given inputs of various sizes, token estimator is monotonic and roughly proportional.
2) Buffer normalization:
- Tool output truncation works; attachments are excluded.
3) State transitions:
- Buffer crossing observe threshold sets `needsObserve`.
- Observations crossing reflect threshold sets `needsReflect`.
4) Message pruning:
- When cursor set, older messages are removed from prompt view.
- Continuation hint is inserted exactly once at the cut boundary.
- OM tool traffic is removed from prompt view.

### Manual acceptance scenarios (in OpenCode)

1) Long tool-heavy session:
- Run repeated tools producing large outputs; verify OM triggers without user action and prompt remains responsive.
2) Continuation stability:
- After pruning, assistant continues naturally without “new chat” behavior.
3) Forget/export:
- `om.export` produces readable memory; `om.forget` clears and resets behavior.
4) Failure resilience:
- Corrupted state file → plugin recreates fresh state and logs an error (does not crash OpenCode).

---

## Storage Options (Pros/Cons) + Recommendation

### Option 1: JSON files in XDG state (Recommended for Phase 1)
Pros:
- Minimal dependencies, easy to inspect/debug.
- Straightforward backups and “forget”.
Cons:
- Requires careful atomic write handling.
- Harder to query across sessions (OK for Phase 1).

### Option 2: SQLite sidecar DB in XDG state
Pros:
- Atomic updates, better concurrency, queryable.
- Scales better if Phase 2/3 add richer data.
Cons:
- More code + migrations.
- Adds dependency surface area.

### Option 3: Store inside OpenCode’s `opencode.db` (core change)
Pros:
- First-class integration, consistent lifecycle with sessions.
Cons:
- Not plugin-first; needs schema migrations + upstream coordination.

Recommendation:
- **Phase 1:** Option 1 (JSON + atomic rename) to iterate quickly.
- Revisit Option 2 when OM format stabilizes or if file corruption/concurrency becomes a real issue.

---

## Rollout Plan

1) Ship plugin behind an “enabled” flag (env/config file).
2) Start with conservative pruning (keep a larger raw tail).
3) Collect feedback on:
   - observation quality,
   - missing details,
   - whether tool outputs are over/under-represented.
4) Tighten thresholds/budgets iteratively.

---

## Known Risks + Mitigations

1) Model doesn’t call OM tools when instructed
- Mitigation: very explicit system instruction + tool.definition reinforcement; log when OM was required but not executed; allow manual `om.observe` command/tool as fallback.

2) Tool outputs dominate memory and reduce quality
- Mitigation: truncate tool outputs; prioritize “outcomes/decisions/errors” over logs in observer prompt guidance.

3) Prompt pruning removes information needed for immediate next step
- Mitigation: keep a raw tail budget; never prune when observation/reflection is pending; always keep the most recent user message and the most recent assistant/tool results.

---

## Open Questions (Track, Don’t Block Phase 1)

- Should Phase 1 include a separate `<reflections>` block, or treat reflection as “rewrite observations” only?
- Should OM be seeded from per-repo memory in a later phase (e.g., repo decisions snapshot)?
- Best default thresholds for typical OpenCode models (8k–200k context) once we see real usage traces.
