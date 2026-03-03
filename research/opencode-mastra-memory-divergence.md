# Mastra vs. OpenCode Observational Memory Divergence Research

**Date:** 2026-03-03
**Scope:** Comparison of OpenCode `observational-memory` plugin (v4) against Mastra's `observational-memory` package.
**Goal:** Identify divergences in prompt engineering, extraction logic, and feedback loops to ensure the plugin delivers Mastra-grade memory quality.

## Executive Summary

The OpenCode plugin successfully adapts Mastra's architecture (Observer/Reflector split, episodic-to-semantic shift) to the OpenCode tool loop. However, the **prompt content** and **reflexive feedback loops** significantly diverge. The plugin currently uses summarized instructions and lacks the active compression retry logic that is critical for Mastra's long-term stability.

## 1. Instruction Depth & Examples (Major Divergence)

The plugin uses heavily condensed summaries of Mastra's instructions. Mastra's actual prompts are much more extensive, containing specific examples and "negative constraints" (what *not* to do) that are critical for quality.

### Comparison

| Feature | OpenCode Plugin | Mastra Implementation | Impact |
| :--- | :--- | :--- | :--- |
| **Instruction Length** | ~20 lines | ~180 lines (`observer-agent.ts`) | Plugin misses edge-case handling. |
| **Unusual Phrasing** | Missing | Explicit instruction to quote user terms (e.g., "movement session"). | Plugin may lose user's specific vocabulary. |
| **Action Verbs** | Missing | Rules for converting "got" -> "purchased/subscribed". | Plugin observations may be vague. |
| **Assistant Content** | Missing | Detailed rules for preserving lists, creative content, stats. | Plugin may drop critical assistant output details. |
| **Temporal Anchoring** | Basic rules | Concrete "BAD vs GOOD" examples for date handling. | Plugin may fail to anchor relative dates correctly. |

**Code Reference (Mastra):** `packages/memory/src/processors/observational-memory/observer-agent.ts` (lines 7-180)

**Recommendation:** Replace the plugin's `OBSERVER_EXTRACTION_INSTRUCTIONS` with the full text from Mastra. The token cost is justified by the increase in observation quality.

## 2. Reflection Compression Loop (Functional Divergence)

Mastra implements an active **retry loop** with escalating guidance when a reflection fails to compress the data sufficiently. The plugin currently lacks this feedback loop, relying on a single pass or deferral.

### Comparison

| Feature | OpenCode Plugin | Mastra Implementation | Impact |
| :--- | :--- | :--- | :--- |
| **Retry Logic** | None / Manual | Active loop (Level 0 -> 1 -> 2 -> 3) based on output size. | Plugin memory may bloat without correction. |
| **Compression Levels** | Exposed as *output* arg | Injected as *input* guidance in system prompt. | Model cannot "choose" to compress; it must be told to. |
| **Failure Handling** | Defers maintenance | Escalates guidance ("Ruthlessly merge..."). | Plugin halts memory updates; Mastra forces progress. |

**Code Reference (Mastra):** `packages/memory/src/processors/observational-memory/reflector-agent.ts`
- `COMPRESSION_GUIDANCE` map defines 4 distinct levels of aggression.
- Logic validates output token count and re-prompts if target not met.

**Recommendation:**
1.  Remove `compressionLevel` from `om_reflect` tool arguments (it's not a model choice).
2.  Track reflection attempts/failures in the state.
3.  Inject `COMPRESSION_GUIDANCE` into the `experimental.chat.system.transform` prompt based on the current failure count (e.g., if `reflectFailures == 1`, inject Level 1 guidance).

## 3. Minor Divergences & Alignments

| Feature | Status | details |
| :--- | :--- | :--- |
| **Output Format** | Aligned | Plugin uses the same date-grouped, emoji-bullet format. |
| **Priority Levels** | Aligned | Plugin uses 🔴, 🟡, 🟢. |
| **Current Task** | Aligned | Plugin injects `<current-task>` and `<suggested-response>`. |
| **State Clearing** | Action Item | Ensure plugin *clears* `currentTask`/`suggestedResponse` if the model omits them in a new observation (Mastra behavior). |

## 4. Action Plan

1.  **Update Constants:** Port the full `OBSERVER_EXTRACTION_INSTRUCTIONS` and `COMPRESSION_GUIDANCE` constants from Mastra to the plugin.
2.  **Refactor Reflection:** Modify the `om_reflect` tool and system prompt injection to support a retry loop driven by `reflectFailures` count.
3.  **Sanitize Inputs:** Ensure the "New history to observe" block in the system prompt matches Mastra's formatting (timestamps, roles) to ensure the `BAD vs GOOD` examples in the instructions apply correctly.
