# OpenCode x Mastra Memory Integration Research

Date: 2026-03-02

Goal: incorporate Mastra-style memory strategies from `mastra-ai/mastra` (notably `packages/memory`) into `anomalyco/opencode`.

Decision (from user): cross-session memory should be **per project/repo** first, with an optional global (cross-repo) setting in a later phase.

This document:
- Locates where Mastra implements the four complementary memory types.
- Describes how OpenCode currently persists conversations and manages context.
- Maps Mastra's memory model onto OpenCode's architecture.
- Recommends an implementation strategy (plugin-first vs fork/core).

Verification approach: initial analysis used upstream raw GitHub fetches and Mastra docs, then findings were validated with local clones pinned to these SHAs:
- `anomalyco/opencode`: `78069369e2253c9788c09b7a71478d140c9741f2` (branch `dev` at time of analysis)
- `mastra-ai/mastra`: `23b43ddd0e3db05dee828c2733faa2496b7b0319` (branch `main` at time of analysis)

Correction from local verification:
- At this Mastra SHA, code defaults `semanticRecall` to `false` in `packages/core/src/memory/memory.ts` (`memoryDefaultOptions`).
- Some docs/pages describe semantic recall as enabled by default; for implementation planning against this SHA, treat semantic recall as opt-in.

---

## Quick Recommendation

Start with a **plugin** to validate behavior and UX, because OpenCode already exposes the right interception points:
- Inject memory into prompts (`experimental.chat.system.transform`, `experimental.chat.messages.transform`).
- Observe user messages and tool results (`chat.message`, `tool.execute.after`).
- Add tools (plugin `tool` registry) to support working memory updates.

Forking OpenCode becomes attractive only if you need:
- first-class UI for memory,
- tight coupling with OpenCode's compaction/prune,
- schema migrations in `opencode.db` for an integrated embeddings/vector index and observational-memory records,
- or you want to upstream the feature.

---

## The Four Memory Types (Docs vs Code)

Mastra docs define four complementary types:
1) Message history
2) Working memory
3) Semantic recall
4) Observational memory

I was able to locate all four in Mastra's codebase.

OpenCode currently implements:
- Message history: YES (session transcript persisted in SQLite; prompt built from stored messages).
- Working memory: PARTIAL/AD-HOC (TODO list is persisted; there is no general “user profile/preferences” memory).
- Semantic recall: NO (no embeddings/vector retrieval).
- Observational memory: PARTIAL/RELATED (compaction + pruning are similar in spirit but not equivalent to Mastra OM).

---

## Repo Pointers

### OpenCode (anomalyco/opencode, branch `dev`)

Persistence + conversation model:
- `packages/opencode/src/storage/db.ts`
- `packages/opencode/src/session/session.sql.ts`
- `packages/opencode/src/session/index.ts`
- `packages/opencode/src/session/message-v2.ts`
- `packages/opencode/src/session/todo.ts`

Prompt loop and tool execution:
- `packages/opencode/src/session/prompt.ts`
- `packages/opencode/src/session/processor.ts`
- `packages/opencode/src/session/llm.ts`

Context control:
- `packages/opencode/src/session/compaction.ts`

Plugin system:
- `packages/opencode/src/plugin/index.ts`
- `packages/plugin/src/index.ts`

Paths and background tasks:
- `packages/opencode/src/global/index.ts`
- `packages/opencode/src/scheduler/index.ts`

### Mastra (mastra-ai/mastra)

Core memory abstraction:
- `packages/core/src/memory/memory.ts` (MastraMemory base + auto-wiring processors)
- `packages/core/src/memory/types.ts` (MemoryConfig + OM config + thread OM metadata)

Memory processors (MessageHistory / WorkingMemory / SemanticRecall):
- `packages/core/src/processors/memory/message-history.ts`
- `packages/core/src/processors/memory/working-memory.ts`
- `packages/core/src/processors/memory/semantic-recall.ts`

Working memory utilities:
- `packages/core/src/memory/working-memory-utils.ts`

Concrete Memory implementation (higher-level behavior + vector batching/chunking):
- `packages/memory/src/index.ts`
- `packages/memory/src/tools/working-memory.ts`

Observational memory (Observer/Reflector, buffering/activation/reflection):
- `packages/memory/src/processors/observational-memory/observational-memory.ts`
- `packages/memory/src/processors/observational-memory/observer-agent.ts`
- `packages/memory/src/processors/observational-memory/reflector-agent.ts`
- `packages/memory/src/processors/observational-memory/types.ts`

---

## Mastra Memory Deep Dive (How It Works)

Mastra's key architectural choice: memory is implemented as **processors** in the agent pipeline.
- Input processors: load/inject memory into the context window before the LLM call.
- Output processors: persist new messages and update indexes after the LLM call.

This makes memory composable, testable, and guardrail-friendly.

### 1) Message History (Mastra)

Where:
- `packages/core/src/processors/memory/message-history.ts`

Behavior:
- On input:
  - Reads the last N messages from storage for `{threadId, resourceId}`.
  - Filters out `role: system`.
  - Deduplicates against already-present message ids.
  - Reverses from DESC query order to chronological order for the model.
- On output:
  - Persists new input + response messages.
  - Skips partial tool-call streaming artifacts.
  - Removes any `updateWorkingMemory` tool invocations from stored history.
  - Strips `<working_memory>...</working_memory>` tags from stored content.
  - Drops messages that were only working-memory tool traffic.

Why it matters for OpenCode:
- The “strip WM tags + drop WM tool calls” rules prevent memory from polluting conversation history.
- The “reverse to chronological” detail is an easy bug to replicate when paginating.

### 2) Working Memory (Mastra)

Where:
- `packages/core/src/processors/memory/working-memory.ts` (injects WM into system prompt)
- `packages/memory/src/tools/working-memory.ts` (tool semantics; schema merge)
- `packages/core/src/memory/working-memory-utils.ts` (tag parsing/removal)

Representation:
- A persistent string block (Markdown template) or JSON object (schema-based).
- Injected into the prompt as a system instruction (with `<working_memory_data>...</working_memory_data>`).

Update mechanism:
- A dedicated tool: `updateWorkingMemory`.
- Scope:
  - `resource` (default): stored once per resource/user; shared across all threads.
  - `thread`: stored in thread metadata; isolated per conversation.

Schema mode:
- “merge semantics”: update only fields you provide.
- `null` deletes keys.
- arrays replace wholesale.

### 3) Semantic Recall (Mastra)

Where:
- `packages/core/src/processors/memory/semantic-recall.ts` (processor version)
- `packages/memory/src/index.ts` (concrete Memory: chunking + batching + vector sync on edits)

Behavior:
- On input:
  - Embed current user query.
  - Vector search by `resource_id` (default scope) or `thread_id`.
  - Fetch matched messages plus surrounding context (`messageRange`).
  - Inject the result into context (either as messages or as a system block; resource-scope often uses a special “remembered from other conversation” block).
- On output:
  - Embed new messages.
  - Upsert to vector store with metadata linking chunks to original `{message_id, thread_id, resource_id}`.

Important implementation details in `packages/memory/src/index.ts`:
- Chunking: approximates tokens by chars and splits text into chunks to fit embedder limits.
- Embedding cache: xxhash-based cache avoids recomputing for repeated content.
- Upsert batching: flattens all vectors across messages and performs one upsert to avoid pool exhaustion.
- Vector sync on update: deletes prior vectors by `message_id` across indexes and upserts new ones.

### 4) Observational Memory (Mastra OM)

Where:
- `packages/memory/src/processors/observational-memory/observational-memory.ts`
- `packages/memory/src/processors/observational-memory/observer-agent.ts`
- `packages/memory/src/processors/observational-memory/reflector-agent.ts`

Concept:
- Replace unbounded raw message history with a dense observation log.
- Two background agents:
  - Observer: produces observations + current task + suggested response.
  - Reflector: compresses observations when they exceed a threshold.

What gets injected into context every step:
- A system message containing `<observations>...</observations>` (plus rules, and optionally `<current-task>` and `<suggested-response>`).
- A synthetic user-role continuation hint message (`om-continuation`) wrapped in `<system-reminder>`.

Token thresholds and buffering:
- Observation triggers when unobserved message tokens exceed `observation.messageTokens`.
- Reflection triggers when observation tokens exceed `reflection.observationTokens`.
- Async buffering (thread scope only): generates observation chunks in the background, then “activates” them instantly when threshold is hit.
- Safety: a `blockAfter` threshold forces synchronous observation/reflection if buffering cannot keep up.

Storage model (key parts):
- Messages remain full fidelity and are still stored normally.
- OM state is stored separately as an `ObservationalMemoryRecord` (active observations, buffers, token counters, flags).
- Per-thread OM cursor and hints are stored under `thread.metadata.mastra.om`:
  - `lastObservedAt`
  - `currentTask`
  - `suggestedResponse`

Why it matters for OpenCode:
- OM is an “always-on” context injection system, not just an overflow summarizer.
- It is designed to keep prompts stable/cachable and to avoid “context rot” from raw tool logs.

---

## OpenCode Deep Dive (How It Works Today)

### Data Model (SQLite)

Where:
- `packages/opencode/src/session/session.sql.ts`
- `packages/opencode/src/storage/db.ts`

Key tables:
- `project`: project identity and worktree.
- `session`: conversation container.
- `message`: message info JSON blob.
- `part`: message parts JSON blob (text, tool, file, reasoning, compaction, etc.).
- `todo`: per-session todo list.

Project identity (important for “per repo” scope):
- `Session.createNext()` sets `projectID = Instance.project.id`.
- Storage migration code indicates for git projects the project id is often the **root commit hash** (stable per repo), making it a good per-repo resource key.

### Message Assembly For The LLM

Where:
- `packages/opencode/src/session/message-v2.ts`

Mechanics:
- OpenCode stores messages/parts and rebuilds an AI SDK compatible message list using `MessageV2.toModelMessages(...)`.
- Tool calls/results are represented as tool parts; outputs may include attachments.
- Some providers require media extracted from tool results to be injected as separate user messages.

### Context Management: Compaction + Pruning

Where:
- `packages/opencode/src/session/compaction.ts`
- `packages/opencode/src/session/message-v2.ts` (`filterCompacted`)

Compaction:
- Triggered on overflow risk or explicit compaction tasks.
- Produces an assistant message with `summary: true` that serves as a continuation prompt.
- Next prompt excludes everything before the compaction boundary (`filterCompacted`).

Pruning:
- Old completed tool outputs can be cleared (marked compacted).
- When building the prompt, compacted tool outputs become `"[Old tool result content cleared]"`.

This is conceptually similar to Mastra OM, but:
- It is primarily overflow-driven.
- It generates a single continuation summary message rather than a structured observation log.
- It is session-scoped and does not implement semantic recall across sessions.

### Plugin Hooks (Key To A Plugin-First Memory Strategy)

Where:
- `packages/plugin/src/index.ts` (hook types)
- `packages/opencode/src/plugin/index.ts` (loader/trigger)
- `packages/opencode/src/session/prompt.ts` (calls `experimental.chat.messages.transform`)
- `packages/opencode/src/session/llm.ts` (calls `experimental.chat.system.transform`)

Hooks most relevant to memory:
- `experimental.chat.system.transform`: inject working memory / observations into system prompt.
- `experimental.chat.messages.transform`: inject semantic recall results as synthetic context.
- `chat.message`: observe user input.
- `tool.execute.after`: observe tool results (good signal for memory extraction + indexing).
- `experimental.session.compacting`: customize compaction prompt (useful for OM-like summary/observations).
- `tool`: register tools (e.g., `updateWorkingMemory`, `memorySearch`, `memoryForget`).

---

## Mapping Mastra Memory To OpenCode (Per-Repo Resource Scope)

Mastra terms -> OpenCode terms:
- `threadId` -> `session.id`
- `resourceId` -> **project/repo id** (recommended: `project.id`)

Why `project.id` is a good “resource” key:
- For git repos, it appears to be a stable identifier derived from the repo (root commit hash). This is a natural boundary for memory relevance.
- Sessions already link to project via `session.project_id`.

Non-git projects:
- OpenCode can run outside a git repo; in that case you need a fallback resource key. Options:
  - hash(worktree path)
  - hash(directory)
  - explicit config `memory.resource_id`

---

## Implementation Strategy For OpenCode

### Plugin-First (Recommended)

Implement a plugin that provides:
1) Working memory per repo
2) Semantic recall per repo
3) Optional OM-like observation log per repo or per session

Storage location for plugin state:
- Prefer OpenCode's data dir (`Global.Path.data`) so it is not committed to the repo.
- Example: `${XDG_DATA_HOME}/opencode/memory/<projectId>/...`.

Plugin responsibilities:
- Observe:
  - `chat.message` (user text)
  - `tool.execute.after` (tool output + metadata)
- Store:
  - working memory: single string (or JSON) keyed by `projectId`
  - semantic index: embeddings keyed by `{projectId, sessionId, messageId}`
  - observations: append-only log keyed by `projectId` or `{projectId, sessionId}`
- Recall/inject:
  - `experimental.chat.system.transform` adds a stable memory prefix:
    - working memory
    - (optional) observations
  - `experimental.chat.messages.transform` adds dynamic recalled snippets:
    - topK semantic matches + short surrounding context

Pros:
- No fork maintenance.
- Can iterate quickly on templates and retrieval heuristics.
- Can be swapped out (different vector backends, different extraction policies).

Cons:
- Memory won't be “first-class” in OpenCode's core DB schema unless you later upstream.

### Core/Fork (Later, If Needed)

Add native tables + migrations in OpenCode's `opencode.db`:
- `repo_memory` / `project_memory` table (working memory per project)
- `message_embedding` table + vector index
- `observational_memory` record table (active observations, buffers, cursors)

Integrate memory selection in `SessionPrompt.loop()`:
- Build effective prompt context as:
  - system prompt
  - instruction files
  - working memory block
  - observations block
  - semantic recall block
  - message history (as OpenCode already does)

---

## Phased Roadmap (Per-Repo First)

Given the target use case (long multi-hour coding sessions with heavy tool output), prioritize Observational Memory before Semantic Recall.

### Phase 1: Observational Memory (primary)

Two viable implementation paths:

Approach A: “Upgrade Compaction” (fastest path)
- Use `experimental.session.compacting` to generate OM-style output instead of generic continuation summary:
  - `<observations>`
  - `<current-task>`
  - `<suggested-response>`
- Persist observations per `projectId` and inject them each turn via `experimental.chat.system.transform`.
- Keep OpenCode's existing prune behavior for old tool outputs.

Approach B: True OM (closer to Mastra)
- Implement Observer/Reflector background runs.
- Track observation/reflection thresholds and activation markers.
- Proactively keep raw message history small while preserving continuity.
- Use `Scheduler.register(...)` for background buffering/reflection tasks.

Recommended for Phase 1: start with Approach A (OM-lite), then evolve toward B once quality is validated.

### Phase 2: Working Memory (minimal + bounded)

Use Working Memory only for compact, durable profile/state facts (not event logs).

Plugin implementation:
- Add `updateWorkingMemory` tool (start with Markdown replace semantics).
- Persist per `projectId`.
- Inject WM as a compact system block.

Bloat mitigation (important):
- Keep a strict token budget (for example 300-800 tokens max).
- Use a fixed template with small slots (preferences, goals, constraints, repo decisions).
- Never store chronological logs or tool traces in WM; that belongs in OM.
- Update only on real change; avoid rewriting unchanged content each turn.
- Add periodic cleanup/compaction for stale fields.

### Phase 3: Semantic Recall (optional)

Add only if you need high-fidelity recall of specific old details that OM/WM do not retain.

Plugin implementation:
- Embedding model: start with one provider/model; make configurable later.
- Vector storage:
  1) Local: SQLite + `sqlite-vec` / `sqlite-vss`
  2) Remote: pgvector/pinecone/etc.
- Retrieval policy:
  - topK + messageRange
  - filter by `projectId`
  - inject as one compact block to limit context bloat

---

## How OpenCode Already Helps (And Where It Conflicts)

Helpful:
- Strong persistence model for messages and parts.
- Built-in compaction + tool-output pruning reduces context waste.
- Plugin hooks allow injection/observation without forking.

Potential conflicts:
- OpenCode already produces compaction summaries and uses them as boundaries. If you also implement OM, decide whether:
  - OM replaces compaction entirely, or
  - OM uses compaction as one signal/trigger.
- Avoid persisting synthetic recall-injection messages, or they will pollute history.

---

## Open Questions / Ambiguities (Not Blocking Phase 1)

1) OM implementation depth for Phase 1:
- compaction-upgrade only (OM-lite) vs early Observer/Reflector background agents

2) Working memory budget policy (Phase 2):
- exact max token budget
- replacement rules when the budget is exceeded

3) Vector backend preference for Phase 3 (if enabled):
- local SQLite vector extension vs remote vector DB

4) Privacy controls:
- easy per-repo “forget all memory”
- easy export/inspect

5) Non-git projects:
- exact fallback resource key policy

---

## Suggested Next Step

Implement Phase 1 as a plugin focused on OM-lite:
- customize compaction output into `<observations>`, `<current-task>`, and `<suggested-response>`
- store these per repo at `${Global.Path.data}/memory/<projectId>/observations.json`
- inject OM context each turn via `experimental.chat.system.transform`

Then add bounded working memory (Phase 2), and defer semantic recall to Phase 3 if needed.
