# Phase 1.2: Observational Memory Alignment

Date: 2026-03-03
Source research: `research/opencode-mastra-memory-divergence.md`
Builds on: `plans/phase-1-1-observational-memory-llm-extraction.md`

## Summary

Phase 1.1 introduced LLM-driven extraction, but research shows the prompts and feedback loops diverge significantly from Mastra's production implementation. Phase 1.2 focuses on **alignment**: importing the full-fidelity instructions and implementing the adaptive compression loop.

## Goals

1.  **High-Fidelity Extraction:** Replace summarized instructions with Mastra's full 180-line `OBSERVER_EXTRACTION_INSTRUCTIONS` to capture precise details, action verbs, and correct temporal anchoring.
2.  **Adaptive Compression:** Implement Mastra's "Level 0-3" compression guidance loop. If a reflection fails to reduce token count, the next system prompt must inject stricter guidance.
3.  **Correct Tool Semantics:** Fix the `om_reflect` tool definition (remove `compressionLevel` as an output arg) and ensure `currentTask` / `suggestedResponse` are cleared when omitted.

## Implementation Details

### 1. Update Instructions & Constants
**Source:** `repos/mastra/packages/memory/src/processors/observational-memory/observer-agent.ts`
**Target:** `.opencode/plugins/observational-memory.ts`

- [x] Replace `OBSERVER_EXTRACTION_INSTRUCTIONS` with the full Mastra text.
- [x] Add `COMPRESSION_GUIDANCE` constant (Map<number, string>) from `reflector-agent.ts`.
- [x] Add `OBSERVER_GUIDELINES` constant (if distinct from extraction instructions) to match Mastra's system prompt structure.

### 2. Refactor Reflection Logic
**Current Behavior:** `om_reflect` takes `compressionLevel` as an arg (incorrectly asking model to choose). Failures just increment a counter and defer.
**New Behavior:**
- [x] **Tool Definition:** Remove `compressionLevel` from `om_reflect` args.
- [x] **State Tracking:** Use `state.stats.reflectFailures` (or a new `runtime.compressionLevel`) to track retry depth.
- [x] **System Prompt Injection:** In `experimental.chat.system.transform`:
    - Determine compression level based on `reflectFailures`.
    - Level 0 (First attempt): Standard prompt.
    - Level 1-3 (Retries): Append corresponding `COMPRESSION_GUIDANCE` to the prompt.
- [x] **Validation:** Inside `applyReflectToolResult`:
    - Calculate `newTokens`.
    - If `newTokens >= oldTokens` (or some threshold), reject the update (unless Level 3), increment `reflectFailures`, and return.
    - This forces the *next* turn to see the failure and inject stricter guidance.

### 3. State & Context Handling
- [x] **Clear Stale Context:** In `applyObserveToolResult` and `applyReflectToolResult`, if `currentTask` or `suggestedResponse` are missing from `args`, explicitly set `state.memory.currentTask = undefined` (etc).
- [x] **Formatting:** Verify `formatObservedTurnGroup` aligns with the timestamp/role format expected by Mastra's examples.

## Verification Plan

1.  **Static Check:** Verify constants match Mastra repo exactly.
2.  **Compression Simulation:**
    - Force `reflectRequired`.
    - Mock a "bad" reflection (no compression).
    - Verify next turn injects Level 1 guidance.
    - Mock a "good" reflection.
    - Verify state updates and failure count clears.
3.  **Observation Quality:** Run a short session with complex user assertions ("I'm moving from X to Y next week") and verify the extracted observation captures the specific "moving" verb and dates per Mastra's examples.

## Verification Status

- [x] Observer prompt now injects `OBSERVER_GUIDELINES` alongside the full extraction instructions and output format.
- [x] Reflection retry validation now rejects non-reducing outputs as well as over-threshold outputs until retry level 3.
- [x] `om_reflect` now clears stale `currentTask` / `suggestedResponse` values when those fields are omitted.
- [x] Focused plugin smoke validation passed via `node --experimental-strip-types scripts/smoke-om-plugin.mjs` on March 3, 2026.
- [x] Full OpenCode CLI smoke validation passed via `node --experimental-strip-types scripts/smoke-om-plugin.mjs --opencode` on March 3, 2026.

**Status:** Complete. Plugin aligned with Mastra v0.1.0-alpha and verified by both focused and OpenCode-backed smoke paths on March 3, 2026.
