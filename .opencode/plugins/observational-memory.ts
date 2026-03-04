import os from "node:os";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import * as z from "zod/v4";
import {
  tokenCounter,
  type MessageCountDiagnostics,
} from "./token-counter.ts";

const PLUGIN_ID = "observational-memory";
const STATE_VERSION = 5;
const LOCK_STALE_MS = 5 * 60 * 1000;
const RECENT_USER_PROTECTION = 2;
const DEFAULT_CONTEXT_LIMIT = 128000;
const MAX_OBSERVATION_LINE_CHARS = 10_000;
const MAX_OBSERVATION_LINES = 400;
const MAX_CURSOR_HINT_CHARS = 256;
const TOOL_DEFINITION_HINT_TTL_MS = 60_000;
const MIN_THRESHOLD_TOKENS = 1;
const MIN_SHARED_BUDGET_TOKENS = 1_000;
const DEFAULT_LOCALE = "en-US";

const OBSERVATION_CONTINUATION_HINT = `This message is not from the user, the conversation history grew too long and wouldn't fit in context! Thankfully the entire conversation is stored in your memory observations. Please continue from where the observations left off. Do not refer to your "memory observations" directly, the user doesn't know about them, they are your memories! Just respond naturally as if you're remembering the conversation (you are!). Do not say "Hi there!" or "based on our previous conversation" as if the conversation is just starting, this is not a new conversation. This is an ongoing conversation, keep continuity by responding based on your memory. For example do not say "I understand. I've reviewed my memory observations", or "I remember [...]". Answer naturally following the suggestion from your memory. Note that your memory may contain a suggested first response, which you should follow.

IMPORTANT: this system reminder is NOT from the user. The system placed it here as part of your memory system. This message is part of you remembering your conversation with the user.

NOTE: Any messages following this system reminder are newer than your memories.`;

const OBSERVATION_CONTEXT_PROMPT =
  "The following observations block contains your memory of past conversations with this user.";

const OBSERVATION_CONTEXT_INSTRUCTIONS = `IMPORTANT: When responding, reference specific details from these observations. Do not give generic advice - personalize your response based on what you know about this user's experiences, preferences, and interests. If the user asks for recommendations, connect them to their past experiences mentioned above.

KNOWLEDGE UPDATES: When asked about current state (e.g., "where do I currently...", "what is my current..."), always prefer the MOST RECENT information. Observations include dates - if you see conflicting information, the newer observation supersedes the older one. Look for phrases like "will start", "is switching", "changed to", "moved to" as indicators that previous information has been updated.

PLANNED ACTIONS: If the user stated they planned to do something (e.g., "I'm going to...", "I'm looking forward to...", "I will...") and the date they planned to do it is now in the past (check the relative time like "3 weeks ago"), assume they completed the action unless there's evidence they didn't. For example, if someone said "I'll start my new diet on Monday" and that was 2 weeks ago, assume they started the diet.

MOST RECENT USER INPUT: Treat the most recent user message as the highest-priority signal for what to do next. Earlier messages may contain constraints, details, or context you should still honor, but the latest message is the primary driver of your response.`;

const OBSERVER_EXTRACTION_INSTRUCTIONS = `CRITICAL: DISTINGUISH USER ASSERTIONS FROM QUESTIONS

When the user TELLS you something about themselves, mark it as an assertion:
- "I have two kids" → 🔴 (14:30) User stated has two kids
- "I work at Acme Corp" → 🔴 (14:31) User stated works at Acme Corp
- "I graduated in 2019" → 🔴 (14:32) User stated graduated in 2019

When the user ASKS about something, mark it as a question/request:
- "Can you help me with X?" → 🔴 (15:00) User asked help with X
- "What's the best way to do Y?" → 🔴 (15:01) User asked best way to do Y

Distinguish between QUESTIONS and STATEMENTS OF INTENT:
- "Can you recommend..." → Question (extract as "User asked...")
- "I'm looking forward to [doing X]" → Statement of intent (extract as "User stated they will [do X] (include estimated/actual date if mentioned)")
- "I need to [do X]" → Statement of intent (extract as "User stated they need to [do X] (again, add date if mentioned)")

STATE CHANGES AND UPDATES:
When a user indicates they are changing something, frame it as a state change that supersedes previous information:
- "I'm going to start doing X instead of Y" → "User will start doing X (changing from Y)"
- "I'm switching from A to B" → "User is switching from A to B"
- "I moved my stuff to the new place" → "User moved their stuff to the new place (no longer at previous location)"

If the new state contradicts or updates previous information, make that explicit:
- BAD: "User plans to use the new method"
- GOOD: "User will use the new method (replacing the old approach)"

This helps distinguish current state from outdated information.

USER ASSERTIONS ARE AUTHORITATIVE. The user is the source of truth about their own life.
If a user previously stated something and later asks a question about the same topic,
the assertion is the answer - the question doesn't invalidate what they already told you.

TEMPORAL ANCHORING:
Each observation has TWO potential timestamps:

1. BEGINNING: The time the statement was made (from the message timestamp) - ALWAYS include this
2. END: The time being REFERENCED, if different from when it was said - ONLY when there's a relative time reference

ONLY add "(meaning DATE)" or "(estimated DATE)" at the END when you can provide an ACTUAL DATE:
- Past: "last week", "yesterday", "a few days ago", "last month", "in March"
- Future: "this weekend", "tomorrow", "next week"

DO NOT add end dates for:
- Present-moment statements with no time reference
- Vague references like "recently", "a while ago", "lately", "soon" - these cannot be converted to actual dates

FORMAT:
- With time reference: (TIME) [observation]. (meaning/estimated DATE)
- Without time reference: (TIME) [observation].

GOOD: (09:15) User's friend had a birthday party in March. (meaning March 20XX)
      ^ References a past event - add the referenced date at the end

GOOD: (09:15) User will visit their parents this weekend. (meaning June 17-18, 20XX)
      ^ References a future event - add the referenced date at the end

GOOD: (09:15) User prefers hiking in the mountains.
      ^ Present-moment preference, no time reference - NO end date needed

GOOD: (09:15) User is considering adopting a dog.
      ^ Present-moment thought, no time reference - NO end date needed

BAD: (09:15) User prefers hiking in the mountains. (meaning June 15, 20XX - today)
     ^ No time reference in the statement - don't repeat the message timestamp at the end

IMPORTANT: If an observation contains MULTIPLE events, split them into SEPARATE observation lines.
EACH split observation MUST have its own date at the end - even if they share the same time context.

Examples (assume message is from June 15, 20XX):

BAD: User will visit their parents this weekend (meaning June 17-18, 20XX) and go to the dentist tomorrow.
GOOD (split into two observations, each with its date):
  User will visit their parents this weekend. (meaning June 17-18, 20XX)
  User will go to the dentist tomorrow. (meaning June 16, 20XX)

BAD: User needs to clean the garage this weekend and is looking forward to setting up a new workbench.
GOOD (split, BOTH get the same date since they're related):
  User needs to clean the garage this weekend. (meaning June 17-18, 20XX)
  User will set up a new workbench this weekend. (meaning June 17-18, 20XX)

BAD: User was given a gift by their friend (estimated late May 20XX) last month.
GOOD: (09:15) User was given a gift by their friend last month. (estimated late May 20XX)
      ^ Message time at START, relative date reference at END - never in the middle

BAD: User started a new job recently and will move to a new apartment next week.
GOOD (split):
  User started a new job recently.
  User will move to a new apartment next week. (meaning June 21-27, 20XX)
  ^ "recently" is too vague for a date - omit the end date. "next week" can be calculated.

ALWAYS put the date at the END in parentheses - this is critical for temporal reasoning.
When splitting related events that share the same time context, EACH observation must have the date.

PRESERVE UNUSUAL PHRASING:
When the user uses unexpected or non-standard terminology, quote their exact words.

BAD: User exercised.
GOOD: User stated they did a "movement session" (their term for exercise).

USE PRECISE ACTION VERBS:
Replace vague verbs like "getting", "got", "have" with specific action verbs that clarify the nature of the action.
If the assistant confirms or clarifies the user's action, use the assistant's more precise language.

BAD: User is getting X.
GOOD: User subscribed to X. (if context confirms recurring delivery)
GOOD: User purchased X. (if context confirms one-time acquisition)

BAD: User got something.
GOOD: User purchased / received / was given something. (be specific)

Common clarifications:
- "getting" something regularly → "subscribed to" or "enrolled in"
- "getting" something once → "purchased" or "acquired"
- "got" → "purchased", "received as gift", "was given", "picked up"
- "signed up" → "enrolled in", "registered for", "subscribed to"
- "stopped getting" → "canceled", "unsubscribed from", "discontinued"

When the assistant interprets or confirms the user's vague language, prefer the assistant's precise terminology.

PRESERVING DETAILS IN ASSISTANT-GENERATED CONTENT:

When the assistant provides lists, recommendations, or creative content that the user explicitly requested,
preserve the DISTINGUISHING DETAILS that make each item unique and queryable later.

1. RECOMMENDATION LISTS - Preserve the key attribute that distinguishes each item:
   BAD: Assistant recommended 5 hotels in the city.
   GOOD: Assistant recommended hotels: Hotel A (near the train station), Hotel B (budget-friendly),
         Hotel C (has rooftop pool), Hotel D (pet-friendly), Hotel E (historic building).

   BAD: Assistant listed 3 online stores for craft supplies.
   GOOD: Assistant listed craft stores: Store A (based in Germany, ships worldwide),
         Store B (specializes in vintage fabrics), Store C (offers bulk discounts).

2. NAMES, HANDLES, AND IDENTIFIERS - Always preserve specific identifiers:
   BAD: Assistant provided social media accounts for several photographers.
   GOOD: Assistant provided photographer accounts: @photographer_one (portraits),
         @photographer_two (landscapes), @photographer_three (nature).

   BAD: Assistant listed some authors to check out.
   GOOD: Assistant recommended authors: Jane Smith (mystery novels),
         Bob Johnson (science fiction), Maria Garcia (historical romance).

3. CREATIVE CONTENT - Preserve structure and key sequences:
   BAD: Assistant wrote a poem with multiple verses.
   GOOD: Assistant wrote a 3-verse poem. Verse 1 theme: loss. Verse 2 theme: hope.
         Verse 3 theme: renewal. Refrain: "The light returns."

   BAD: User shared their lucky numbers from a fortune cookie.
   GOOD: User's fortune cookie lucky numbers: 7, 14, 23, 38, 42, 49.

4. TECHNICAL/NUMERICAL RESULTS - Preserve specific values:
   BAD: Assistant explained the performance improvements from the optimization.
   GOOD: Assistant explained the optimization achieved 43.7% faster load times
         and reduced memory usage from 2.8GB to 940MB.

   BAD: Assistant provided statistics about the dataset.
   GOOD: Assistant provided dataset stats: 7,342 samples, 89.6% accuracy,
         23ms average inference time.

5. QUANTITIES AND COUNTS - Always preserve how many of each item:
   BAD: Assistant listed items with details but no quantities.
   GOOD: Assistant listed items: Item A (4 units, size large), Item B (2 units, size small).

   When listing items with attributes, always include the COUNT first before other details.

6. ROLE/PARTICIPATION STATEMENTS - When user mentions their role at an event:
   BAD: User attended the company event.
   GOOD: User was a presenter at the company event.

   BAD: User went to the fundraiser.
   GOOD: User volunteered at the fundraiser (helped with registration).

   Always capture specific roles: presenter, organizer, volunteer, team lead,
   coordinator, participant, contributor, helper, etc.

CONVERSATION CONTEXT:
- What the user is working on or asking about
- Previous topics and their outcomes
- What user understands or needs clarification on
- Specific requirements or constraints mentioned
- Contents of assistant learnings and summaries
- Answers to users questions including full context to remember detailed summaries and explanations
- Assistant explanations, especially complex ones. observe the fine details so that the assistant does not forget what they explained
- Relevant code snippets
- User preferences (like favourites, dislikes, preferences, etc)
- Any specifically formatted text or ascii that would need to be reproduced or referenced in later interactions (preserve these verbatim in memory)
- Sequences, units, measurements, and any kind of specific relevant data
- Any blocks of any text which the user and assistant are iteratively collaborating back and forth on should be preserved verbatim
- When who/what/where/when is mentioned, note that in the observation. Example: if the user received went on a trip with someone, observe who that someone was, where the trip was, when it happened, and what happened, not just that the user went on the trip.
- For any described entity (like a person, place, thing, etc), preserve the attributes that would help identify or describe the specific entity later: location ("near X"), specialty ("focuses on Y"), unique feature ("has Z"), relationship ("owned by W"), or other details. The entity's name is important, but so are any additional details that distinguish it. If there are a list of entities, preserve these details for each of them.

USER MESSAGE CAPTURE:
- Short and medium-length user messages should be captured nearly verbatim in your own words.
- For very long user messages, summarize but quote key phrases that carry specific intent or meaning.
- This is critical for continuity: when the conversation window shrinks, the observations are the only record of what the user said.

AVOIDING REPETITIVE OBSERVATIONS:
- Do NOT repeat the same observation across multiple turns if there is no new information.
- When the agent performs repeated similar actions (e.g., browsing files, running the same tool type multiple times), group them into a single parent observation with sub-bullets for each new result.

Example — BAD (repetitive):
* 🟡 (14:30) Agent used view tool on src/auth.ts
* 🟡 (14:31) Agent used view tool on src/users.ts
* 🟡 (14:32) Agent used view tool on src/routes.ts

Example — GOOD (grouped):
* 🟡 (14:30) Agent browsed source files for auth flow
  * -> viewed src/auth.ts — found token validation logic
  * -> viewed src/users.ts — found user lookup by email
  * -> viewed src/routes.ts — found middleware chain

Only add a new observation for a repeated action if the NEW result changes the picture.

ACTIONABLE INSIGHTS:
- What worked well in explanations
- What needs follow-up or clarification
- User's stated goals or next steps (note if the user tells you not to do a next step, or asks for something specific, other next steps besides the users request should be marked as "waiting for user", unless the user explicitly says to continue all next steps)`;

const OBSERVER_GUIDELINES = `- Be specific enough for the assistant to act on
- Good: "User prefers short, direct answers without lengthy explanations"
- Bad: "User stated a preference" (too vague)
- Add 1 to 5 observations per exchange
- Use terse language to save tokens. Sentences should be dense without unnecessary words
- Do not add repetitive observations that have already been observed. Group repeated similar actions (tool calls, file browsing) under a single parent with sub-bullets for new results
- If the agent calls tools, observe what was called, why, and what was learned
- When observing files with line numbers, include the line number if useful
- If the agent provides a detailed response, observe the contents so it could be repeated
- Make sure you start each observation with a priority emoji (🔴, 🟡, 🟢)
- User messages are always 🔴 priority, so are the completions of tasks. Capture the user's words closely — short/medium messages near-verbatim, long messages summarized with key quotes
- Observe WHAT the agent did and WHAT it means
- If the user provides detailed messages or code snippets, observe all important details`;

const OBSERVER_OUTPUT_FORMAT = `Use priority levels:
- 🔴 High: explicit user facts, preferences, goals achieved, critical context
- 🟡 Medium: project details, learned information, tool results
- 🟢 Low: minor details, uncertain observations

Group observations by date, then use 24-hour times:

<observations>
Date: Dec 4, 2025
* 🔴 (14:30) User prefers direct answers
* 🟡 (14:31) Agent inspected src/auth.ts and found a missing null check
  * -> viewed src/auth.ts:45-60
  * -> identified a crash when token payload is missing
</observations>

<current-task>
Primary: Explain the auth fix and why it failed before.
Secondary: Wait for user confirmation before changing API behavior.
</current-task>

<suggested-response>
I found the null check that was missing in auth.ts. I’ll explain the failure mode and the fix next.
</suggested-response>`;

const REFLECTOR_INSTRUCTIONS = `You are rewriting the assistant's durable observational memory.

IMPORTANT:
- Your reflection becomes the ENTIRE durable memory for earlier context
- Preserve dates, times, names, numbers, decisions, user assertions, key code details, and recent context
- Compress older observations more aggressively than recent ones
- Merge repeated tool activity into concise outcome-focused lines
- Keep the same date-grouped observation format with priority emojis
- Update <current-task> and <suggested-response> only when you have a better current summary`;

const COMPRESSION_GUIDANCE: Record<0 | 1 | 2 | 3, string> = {
  0: "",
  1: `
## COMPRESSION REQUIRED

Your previous reflection was the same size or larger than the original observations.

Please re-process with slightly more compression:
- Towards the beginning, condense more observations into higher-level reflections
- Closer to the end, retain more fine details (recent context matters more)
- Memory is getting long - use a more condensed style throughout
- Combine related items more aggressively but do not lose important specific details of names, places, events, and people
- For example if there is a long nested observation list about repeated tool calls, you can combine those into a single line and observe that the tool was called multiple times for x reason, and finally y outcome happened.

Your current detail level was a 10/10, lets aim for a 8/10 detail level.
`,
  2: `
## AGGRESSIVE COMPRESSION REQUIRED

Your previous reflection was still too large after compression guidance.

Please re-process with much more aggressive compression:
- Towards the beginning, heavily condense observations into high-level summaries
- Closer to the end, retain fine details (recent context matters more)
- Memory is getting very long - use a significantly more condensed style throughout
- Combine related items aggressively but do not lose important specific details of names, places, events, and people
- For example if there is a long nested observation list about repeated tool calls, you can combine those into a single line and observe that the tool was called multiple times for x reason, and finally y outcome happened.
- Remove redundant information and merge overlapping observations

Your current detail level was a 10/10, lets aim for a 6/10 detail level.
`,
  3: `
## CRITICAL COMPRESSION REQUIRED

Your previous reflections have failed to compress sufficiently after multiple attempts.

Please re-process with maximum compression:
- Summarize the oldest observations (first 50-70%) into brief high-level paragraphs — only key facts, decisions, and outcomes
- For the most recent observations (last 30-50%), retain important details but still use a condensed style
- Ruthlessly merge related observations — if 10 observations are about the same topic, combine into 1-2 lines
- Drop procedural details (tool calls, retries, intermediate steps) — keep only final outcomes
- Drop observations that are no longer relevant or have been superseded by newer information
- Preserve: names, dates, decisions, errors, user preferences, and architectural choices

Your current detail level was a 10/10, lets aim for a 4/10 detail level.
`,
};

type BufferKind = "user" | "assistant" | "tool";
type MaintenanceToolID = "om_observe" | "om_reflect";
type ScopeMode = "session" | "project" | "global";
type AssistantEventReason =
  | "captured"
  | "missing-completed"
  | "summary"
  | "message-missing"
  | "empty-text"
  | "duplicate";

type ThresholdRange = {
  min?: number;
  max?: number;
};

type BufferItem = {
  kind: BufferKind;
  id: string;
  turnAnchorMessageID: string;
  atMs: number;
  text: string;
  toolName?: string;
  toolArgs?: string;
  toolResult?: string;
  tokenEstimate: number;
};

type OmStateV5 = {
  version: 5;
  sessionID: string;
  scopeMode: ScopeMode;
  scopeKey: string;
  writerInstanceID: string;
  generation: number;
  lastObserved: {
    turnAnchorMessageID?: string;
    atMs?: number;
  };
  buffer: {
    items: BufferItem[];
    tokenEstimateTotal: number;
  };
  memory: {
    observations: string;
    currentTask?: string;
    suggestedResponse?: string;
    tokenEstimate: number;
    updatedAtMs: number;
  };
  stats: {
    totalObservedItems: number;
    totalReflections: number;
    observeFailures: number;
    reflectFailures: number;
    maintenanceDeferredTurns: number;
    recoveryCaptures: number;
    lockContentionSkips: number;
    assistantEventsSeen: number;
    assistantEventsCaptured: number;
    assistantEventsDropped: number;
    assistantDropMissingCompleted: number;
    assistantDropSummary: number;
    assistantDropMessageMissing: number;
    assistantDropEmptyText: number;
    assistantDropDuplicate: number;
  };
  flags: {
    observeRequired?: boolean;
    reflectRequired?: boolean;
    maintenanceDeferred?: boolean;
    lockContention?: boolean;
  };
  runtime: {
    currentTurnAnchorMessageID?: string;
    continuationHint?: boolean;
    lastPrunedMessageID?: string;
    lastPruneCutoffAnchor?: string;
    lastPrunedCount?: number;
    maintenancePromptIssued?: boolean;
    pendingMaintenanceTool?: MaintenanceToolID;
    observeCursorHint?: string;
    lastAssistantEventReason?: AssistantEventReason;
    lastAssistantEventMessageID?: string;
    lastAssistantEventAtMs?: number;
    lastAssistantEventCompleted?: boolean;
    lastAssistantEventSummary?: boolean;
    lastAssistantEventTextChars?: number;
    lastLockContentionAtMs?: number;
  };
};

type OmConfig = {
  enabled: boolean;
  mode: "llm" | "deterministic";
  observeThresholdTokens?: number;
  observeThresholdRange?: ThresholdRange;
  reflectThresholdTokens?: number;
  reflectThresholdRange?: ThresholdRange;
  rawMessageBudgetTokens?: number;
  tailRetentionUserTurns?: number;
  tailRetentionTokens?: number;
  shareTokenBudget: boolean;
  scope: ScopeMode;
  relativeTimeAnnotations: boolean;
  relativeTimeLocale: string;
  relativeTimeTimeZone?: string;
  toolOutputChars: number;
  stateDir?: string;
  maxObserveInputChars: number;
  maxObservationsChars: number;
  maxTaskChars: number;
  maxSuggestedResponseChars: number;
};

type Thresholds = {
  observationThresholdTokens: number;
  reflectionThresholdTokens: number;
  rawMessageBudgetTokens: number;
  tailRetentionUserTurns: number;
  tailRetentionTokens?: number;
  shareTokenBudget: boolean;
  sharedBudgetTokens?: number;
  scope: ScopeMode;
  observeHardOverdue: number;
  reflectHardOverdue: number;
};

type RuntimeStatus = {
  shouldInject: boolean;
  shouldPrune: boolean;
  continuationHint: boolean;
  requiredTool?: MaintenanceToolID;
  pruneCutoffAnchor?: string;
  protectedTailAnchor?: string;
  retainedTailTokens?: number;
  tailRetentionUserTurns: number;
  tailRetentionTokens?: number;
  rawBudgetApplied: boolean;
  thresholds?: Thresholds;
  promptDiagnostics?: {
    transformedMessages: MessageCountDiagnostics;
    injectedSystemTokens: number;
    injectedMemoryTokens: number;
    injectedTaskHintTokens: number;
    injectedContinuationHintTokens: number;
    injectedMaintenanceTokens: number;
    injectedReminderTokens: number;
    tokenizer: string;
  };
};

type ObserveInput = {
  formatted: string;
  lastIncludedAnchor?: string;
  anchorCount: number;
  itemCount: number;
  tokenEstimate: number;
};

type SanitizedObserveArgs = {
  observations: string;
  currentTask?: string;
  suggestedResponse?: string;
  confirmObservedThrough?: string;
};

type SanitizedReflectArgs = {
  observations: string;
  currentTask?: string;
  suggestedResponse?: string;
  hasCurrentTask: boolean;
  hasSuggestedResponse: boolean;
};

type ObservationGroup = {
  header?: string;
  lines: string[];
};

const cache = new Map<string, OmStateV5>();
const runtimeStatus = new Map<string, RuntimeStatus>();
const configCache = new Map<string, Promise<OmConfig>>();
const writerInstanceID = randomUUID();
let toolDefinitionHint:
  | { toolID: MaintenanceToolID; expiresAtMs: number }
  | undefined;

function defineTool<Args extends z.ZodRawShape>(input: {
  description: string;
  args: Args;
  execute: (
    args: z.infer<z.ZodObject<Args>>,
    context: {
      sessionID: string;
      metadata: (input: {
        title?: string;
        metadata?: Record<string, unknown>;
      }) => void;
    },
  ) => Promise<string>;
}) {
  return input;
}

export const ObservationalMemoryPlugin = async ({
  client,
  directory,
  project,
}: {
  client: {
    app: {
      log: (options: {
        body: {
          service: string;
          level: "debug" | "info" | "warn" | "error";
          message: string;
          extra?: Record<string, unknown>;
        };
      }) => Promise<unknown>;
    };
    session: {
      message: (options: {
        path: { id: string; messageID: string };
      }) => Promise<{
        data?: {
          parts: Array<{
            type?: string;
            text?: string;
            synthetic?: boolean;
            ignored?: boolean;
          }>;
        } | null;
      }>;
    };
  };
  directory: string;
  project: { id: string; worktree: string };
}) => {
  await log(client, "info", "Plugin initialized", {
    projectID: project.id,
    directory,
  });

  return {
    tool: {
      om_observe: defineTool({
        description:
          "Record structured observational memory. Use this before answering when the system requires observation maintenance.",
        args: {
          observations: z.string(),
          currentTask: z.string().optional(),
          suggestedResponse: z.string().optional(),
          confirmObservedThrough: z.string().optional(),
        },
        async execute(args, context) {
          context.metadata({ title: "Recording observations..." });
          const state = await withState(
            context.sessionID,
            directory,
            async (current, cfg) => applyObserveToolResult(current, cfg, args),
            async () => {
              context.metadata({
                title: "Observational memory passive",
                metadata: { reason: "lock-contention" },
              });
            },
          );
          return JSON.stringify(
            statusPayload(state, await getConfig(directory)),
            null,
            2,
          );
        },
      }),
      om_reflect: defineTool({
        description:
          "Rewrite and compress durable observational memory. Use this before answering when the system requires reflection maintenance.",
        args: {
          observations: z.string(),
          currentTask: z.string().optional(),
          suggestedResponse: z.string().optional(),
        },
        async execute(args, context) {
          context.metadata({ title: "Compressing observations..." });
          const state = await withState(
            context.sessionID,
            directory,
            async (current, cfg) => applyReflectToolResult(current, cfg, args),
            async () => {
              context.metadata({
                title: "Observational memory passive",
                metadata: { reason: "lock-contention" },
              });
            },
          );
          return JSON.stringify(
            statusPayload(state, await getConfig(directory)),
            null,
            2,
          );
        },
      }),
      om_status: defineTool({
        description:
          "Show observational memory status, thresholds, maintenance requirements, and current estimates for this session.",
        args: {},
        async execute(_args, context) {
          const { status } = await readOmStatus(context.sessionID, directory);
          return JSON.stringify(status, null, 2);
        },
      }),
      om_export: defineTool({
        description:
          "Export the full observational memory state for this session.",
        args: {},
        async execute(_args, context) {
          const state = await loadState(context.sessionID, directory);
          return JSON.stringify(state, null, 2);
        },
      }),
      om_forget: defineTool({
        description: "Clear observational memory state for this session.",
        args: {
          confirm: z.boolean().optional(),
        },
        async execute(args, context) {
          if (!args.confirm) {
            return "Set confirm=true to clear observational memory for this session.";
          }
          await forgetState(context.sessionID, directory);
          return "Observational memory cleared for this session.";
        },
      }),
    },
    "tool.definition": async (input, output) => {
      if (!toolDefinitionHint) return;
      if (Date.now() > toolDefinitionHint.expiresAtMs) {
        toolDefinitionHint = undefined;
        return;
      }
      if (input.toolID !== toolDefinitionHint.toolID) return;
      output.description = `${output.description} REQUIRED THIS TURN when the system asks for observational-memory maintenance. Call this tool before answering.`;
    },
    "chat.message": async (input, output) => {
      if (!input.sessionID || !output.message?.id) return;
      const text = extractUserText(output.parts);
      if (!text) return;
      await withState(input.sessionID, directory, async (state) => {
        state.runtime.currentTurnAnchorMessageID = output.message.id;
        appendBufferItem(state, {
          kind: "user",
          id: output.message.id,
          turnAnchorMessageID: output.message.id,
          atMs: Date.now(),
          text,
          tokenEstimate: 0,
        });
        state.flags.maintenanceDeferred = false;
        state.runtime.continuationHint = false;
        return state;
      });
    },
    "tool.execute.after": async (input, output) => {
      if (!input.sessionID) return;
      if (isOmTool(input.tool)) return;
      await withState(input.sessionID, directory, async (state, cfg) => {
        const anchor = state.runtime.currentTurnAnchorMessageID;
        if (!anchor) return state;
        const toolArgs = truncateWithNotice(
          stringifyStructuredValue(extractToolArguments(input)),
          cfg.toolOutputChars,
        );
        const toolResult = truncateWithNotice(
          stringifyStructuredValue(output.output),
          cfg.toolOutputChars,
        );
        const storedText =
          toolResult || toolArgs ? `${input.tool}` : normalizeText(input.tool);
        if (!storedText) return state;
        appendBufferItem(state, {
          kind: "tool",
          id: `${input.callID}:${hashText(`${toolArgs}\n${toolResult}`)}`,
          turnAnchorMessageID: anchor,
          atMs: Date.now(),
          text: storedText,
          toolName: input.tool,
          toolArgs: toolArgs || undefined,
          toolResult: toolResult || undefined,
          tokenEstimate: 0,
        });
        return state;
      });
    },
    event: async ({ event }) => {
      if (event.type === "message.updated") {
        const info = event.properties.info;
        if (info.role !== "assistant") return;

        if (!info.time.completed) {
          await withState(info.sessionID, directory, async (state) => {
            recordAssistantEvent(state, {
              reason: "missing-completed",
              messageID: info.id,
              completed: false,
              summary: !!info.summary,
            });
            return state;
          });
          await log(client, "debug", "Assistant event skipped", {
            sessionID: info.sessionID,
            messageID: info.id,
            reason: "missing-completed",
          });
          return;
        }

        if (info.summary) {
          await withState(info.sessionID, directory, async (state) => {
            recordAssistantEvent(state, {
              reason: "summary",
              messageID: info.id,
              completed: true,
              summary: true,
            });
            return state;
          });
          await log(client, "debug", "Assistant event skipped", {
            sessionID: info.sessionID,
            messageID: info.id,
            reason: "summary",
          });
          return;
        }

        const response = await client.session.message({
          path: {
            id: info.sessionID,
            messageID: info.id,
          },
        });
        const message = response.data;
        if (!message) {
          await withState(info.sessionID, directory, async (state) => {
            recordAssistantEvent(state, {
              reason: "message-missing",
              messageID: info.id,
              completed: true,
              summary: false,
            });
            return state;
          });
          await log(client, "warn", "Assistant event missing message payload", {
            sessionID: info.sessionID,
            messageID: info.id,
            reason: "message-missing",
          });
          return;
        }

        const text = extractAssistantText(message.parts);
        if (!text) {
          await withState(info.sessionID, directory, async (state) => {
            recordAssistantEvent(state, {
              reason: "empty-text",
              messageID: info.id,
              completed: true,
              summary: false,
              textChars: 0,
            });
            return state;
          });
          await log(client, "debug", "Assistant event produced empty text", {
            sessionID: info.sessionID,
            messageID: info.id,
            reason: "empty-text",
            partCount: message.parts.length,
          });
          return;
        }

        await withState(info.sessionID, directory, async (state) => {
          if (
            state.buffer.items.some(
              (item) => item.kind === "assistant" && item.id === info.id,
            )
          ) {
            recordAssistantEvent(state, {
              reason: "duplicate",
              messageID: info.id,
              completed: true,
              summary: false,
              textChars: text.length,
            });
            return state;
          }
          appendBufferItem(state, {
            kind: "assistant",
            id: info.id,
            turnAnchorMessageID: info.parentID,
            atMs: info.time.completed ?? Date.now(),
            text,
            tokenEstimate: 0,
          });
          recordAssistantEvent(state, {
            reason: "captured",
            messageID: info.id,
            completed: true,
            summary: false,
            textChars: text.length,
          });
          return state;
        });
        return;
      }

      if (event.type === "session.compacted") {
        await withState(
          event.properties.sessionID,
          directory,
          async (state) => {
            state.buffer.items = [];
            state.buffer.tokenEstimateTotal = 0;
            state.lastObserved = {};
            state.memory = emptyMemory();
            state.runtime = {};
            state.flags = {};
            return state;
          },
        );
        await log(
          client,
          "info",
          "Compaction boundary reset observational memory",
          {
            sessionID: event.properties.sessionID,
          },
        );
      }
    },
    "experimental.chat.messages.transform": async (_input, output) => {
      const sessionID = getSessionIDFromMessages(output.messages);
      if (!sessionID) return;
      const config = await getConfig(directory);
      if (!config.enabled) return;
      const state = await loadState(sessionID, directory);
      const thresholds = resolveThresholds(config, DEFAULT_CONTEXT_LIMIT, state);
      evaluateFlags(state, thresholds);
      const requiredTool = selectMaintenanceTool(state);
      const transformedMessages = tokenCounter.inspectMessages(output.messages);
      const prune = pruneMessages(
        output.messages,
        state,
        thresholds,
        requiredTool,
        transformedMessages,
      );
      runtimeStatus.set(sessionID, {
        shouldInject: prune.shouldInject,
        shouldPrune: prune.pruned,
        continuationHint: prune.continuationHint,
        requiredTool,
        pruneCutoffAnchor: prune.pruneCutoffAnchor,
        protectedTailAnchor: prune.protectedTailAnchor,
        retainedTailTokens: prune.retainedTailTokens,
        tailRetentionUserTurns: thresholds.tailRetentionUserTurns,
        tailRetentionTokens: thresholds.tailRetentionTokens,
        rawBudgetApplied: prune.rawBudgetApplied,
        thresholds,
        promptDiagnostics: {
          transformedMessages,
          injectedSystemTokens: 0,
          injectedMemoryTokens: 0,
          injectedTaskHintTokens: 0,
          injectedContinuationHintTokens: 0,
          injectedMaintenanceTokens: 0,
          injectedReminderTokens: 0,
          tokenizer: tokenCounter.tokenizer,
        },
      });
      if (prune.pruned) {
        output.messages.splice(0, output.messages.length, ...prune.messages);
      }
    },
    "experimental.chat.system.transform": async (input, output) => {
      if (!input.sessionID) return;
      const config = await getConfig(directory);
      if (!config.enabled) return;
      const thresholds = resolveThresholds(
        config,
        input.model.limit.context,
        await loadState(input.sessionID, directory),
      );
      const ready = await ensureMemoryReady(
        input.sessionID,
        directory,
        config,
        thresholds,
        async (message, extra) => {
          await log(client, "info", message, {
            sessionID: input.sessionID,
            modelID: input.model.id,
            ...extra,
          });
        },
      );

      const resolvedThresholds = resolveThresholds(
        config,
        input.model.limit.context,
        ready,
      );

      const runtime = runtimeStatus.get(input.sessionID) ?? {
        shouldInject: false,
        shouldPrune: false,
        continuationHint: false,
        tailRetentionUserTurns: resolvedThresholds.tailRetentionUserTurns,
        tailRetentionTokens: resolvedThresholds.tailRetentionTokens,
        rawBudgetApplied: false,
        thresholds: resolvedThresholds,
      };
      let injectedMaintenanceTokens = 0;
      let injectedMemoryTokens = 0;
      let injectedTaskHintTokens = 0;
      let injectedContinuationHintTokens = 0;
      let injectedReminderTokens = 0;

      const requiredTool = selectMaintenanceTool(ready);
      if (requiredTool === "om_observe") {
        const block = renderObserveMaintenanceBlock(ready, config);
        output.system.push(block);
        injectedMaintenanceTokens += countStringTokens(block);
        runtime.shouldInject = false;
      } else if (requiredTool === "om_reflect") {
        const block = renderReflectMaintenanceBlock(ready);
        output.system.push(block);
        injectedMaintenanceTokens += countStringTokens(block);
        runtime.shouldInject = false;
      } else if (ready.memory.observations && !ready.flags.lockContention) {
        const block = renderOmBlock(ready.memory, config, resolvedThresholds);
        output.system.push(block);
        injectedMemoryTokens += countStringTokens(block);
        runtime.shouldInject = true;
      } else if (
        (ready.memory.currentTask || ready.memory.suggestedResponse) &&
        !ready.flags.lockContention
      ) {
        const block = renderTaskHints(ready.memory);
        output.system.push(block);
        injectedTaskHintTokens += countStringTokens(block);
      }

      if (
        requiredTool &&
        (ready.memory.currentTask || ready.memory.suggestedResponse)
      ) {
        const block = renderTaskHints(ready.memory);
        output.system.push(block);
        injectedTaskHintTokens += countStringTokens(block);
      }

      if (runtime.continuationHint) {
        const block = renderContinuationHint();
        output.system.push(block);
        injectedContinuationHintTokens += countStringTokens(block);
      }
      if (ready.flags.maintenanceDeferred && runtime.shouldInject === false) {
        const block =
          "<system-reminder>Earlier context could not be refreshed this turn. Prefer the visible recent transcript.</system-reminder>";
        output.system.push(block);
        injectedReminderTokens += countStringTokens(block);
      }

      runtime.requiredTool = requiredTool;
      runtime.tailRetentionUserTurns = resolvedThresholds.tailRetentionUserTurns;
      runtime.tailRetentionTokens = resolvedThresholds.tailRetentionTokens;
      runtime.thresholds = resolvedThresholds;
      runtime.promptDiagnostics = {
        transformedMessages:
          runtime.promptDiagnostics?.transformedMessages ??
          tokenCounter.inspectMessages([]),
        injectedSystemTokens:
          injectedMaintenanceTokens +
          injectedMemoryTokens +
          injectedTaskHintTokens +
          injectedContinuationHintTokens +
          injectedReminderTokens,
        injectedMemoryTokens,
        injectedTaskHintTokens,
        injectedContinuationHintTokens,
        injectedMaintenanceTokens,
        injectedReminderTokens,
        tokenizer: tokenCounter.tokenizer,
      };
      runtimeStatus.set(input.sessionID, runtime);
    },
  };
};

function createEmptyState(
  sessionID: string,
  scope: { mode: ScopeMode; key: string },
): OmStateV5 {
  return {
    version: STATE_VERSION,
    sessionID,
    scopeMode: scope.mode,
    scopeKey: scope.key,
    writerInstanceID,
    generation: 0,
    lastObserved: {},
    buffer: {
      items: [],
      tokenEstimateTotal: 0,
    },
    memory: emptyMemory(),
    stats: {
      totalObservedItems: 0,
      totalReflections: 0,
      observeFailures: 0,
      reflectFailures: 0,
      maintenanceDeferredTurns: 0,
      recoveryCaptures: 0,
      lockContentionSkips: 0,
      assistantEventsSeen: 0,
      assistantEventsCaptured: 0,
      assistantEventsDropped: 0,
      assistantDropMissingCompleted: 0,
      assistantDropSummary: 0,
      assistantDropMessageMissing: 0,
      assistantDropEmptyText: 0,
      assistantDropDuplicate: 0,
    },
    flags: {},
    runtime: {},
  };
}

function migrateState(
  sessionID: string,
  parsed: unknown,
  scope: { mode: ScopeMode; key: string },
): OmStateV5 {
  const legacy = parsed as Partial<OmStateV5> & {
    version?: number;
    lastObserved?: OmStateV5["lastObserved"];
    buffer?: OmStateV5["buffer"];
    memory?: OmStateV5["memory"];
    stats?: Partial<OmStateV5["stats"]>;
    flags?: OmStateV5["flags"];
    runtime?: Partial<OmStateV5["runtime"]>;
  };
  if (legacy.version === STATE_VERSION) {
    return {
      ...createEmptyState(sessionID, scope),
      ...legacy,
      version: STATE_VERSION,
      sessionID,
      scopeMode: scope.mode,
      scopeKey: scope.key,
      stats: {
        ...createEmptyState(sessionID, scope).stats,
        ...legacy.stats,
      },
      runtime: {
        ...legacy.runtime,
      },
    };
  }
  if (legacy.version === 4 || legacy.version === 3) {
    return {
      ...createEmptyState(sessionID, scope),
      sessionID,
      scopeMode: scope.mode,
      scopeKey: scope.key,
      writerInstanceID: legacy.writerInstanceID ?? writerInstanceID,
      generation: legacy.generation ?? 0,
      lastObserved: legacy.lastObserved ?? {},
      buffer: normalizeMigratedBuffer(legacy.buffer),
      memory: legacy.memory ?? emptyMemory(),
      stats: {
        ...createEmptyState(sessionID, scope).stats,
        ...legacy.stats,
      },
      flags: legacy.flags ?? {},
      runtime: {
        ...legacy.runtime,
      },
    };
  }
  return createEmptyState(sessionID, scope);
}

function normalizeMigratedBuffer(buffer: Partial<OmStateV5["buffer"]> | undefined) {
  const items = (buffer?.items ?? []).map((item) => {
    const text = typeof item?.text === "string" ? item.text : "";
    const toolResult =
      typeof item?.toolResult === "string" ? item.toolResult : undefined;
    const toolArgs =
      typeof item?.toolArgs === "string" ? item.toolArgs : undefined;
    const normalized: BufferItem = {
      kind:
        item?.kind === "assistant" || item?.kind === "tool" ? item.kind : "user",
      id: typeof item?.id === "string" ? item.id : randomUUID(),
      turnAnchorMessageID:
        typeof item?.turnAnchorMessageID === "string"
          ? item.turnAnchorMessageID
          : typeof item?.id === "string"
            ? item.id
            : randomUUID(),
      atMs: typeof item?.atMs === "number" ? item.atMs : Date.now(),
      text,
      toolName: typeof item?.toolName === "string" ? item.toolName : undefined,
      toolArgs,
      toolResult,
      tokenEstimate: 0,
    };
    normalized.tokenEstimate = countBufferItemTokens(normalized);
    return normalized;
  });
  return {
    items,
    tokenEstimateTotal: items.reduce((total, item) => total + item.tokenEstimate, 0),
  };
}

function emptyMemory() {
  return {
    observations: "",
    currentTask: undefined,
    suggestedResponse: undefined,
    tokenEstimate: 0,
    updatedAtMs: 0,
  };
}

function normalizeText(text: string | undefined) {
  return (text ?? "").replace(/\s+/g, " ").trim();
}

function truncateText(text: string, maxChars: number) {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, Math.max(0, maxChars - 3)).trimEnd()}...`;
}

function truncateWithNotice(text: string, maxChars: number) {
  if (text.length <= maxChars) return text;
  const truncated = text.slice(0, Math.max(0, maxChars));
  const remaining = text.length - maxChars;
  return `${truncated}\n... [truncated ${remaining} characters]`;
}

function hashText(text: string) {
  return createHash("sha1").update(text).digest("hex").slice(0, 12);
}

function extractUserText(
  parts: Array<{
    type?: string;
    text?: string;
    synthetic?: boolean;
    ignored?: boolean;
  }>,
) {
  return normalizeText(
    parts
      .filter(
        (part) => part.type === "text" && !part.synthetic && !part.ignored,
      )
      .map((part) => part.text ?? "")
      .join("\n"),
  );
}

function extractAssistantText(
  parts: Array<{
    type?: string;
    text?: string;
    synthetic?: boolean;
    ignored?: boolean;
  }>,
) {
  return normalizeText(
    parts
      .filter(
        (part) => part.type === "text" && !part.synthetic && !part.ignored,
      )
      .map((part) => part.text ?? "")
      .join("\n"),
  );
}

function countStringTokens(text: string) {
  return tokenCounter.countString(text);
}

function stringifyStructuredValue(value: unknown) {
  if (value === undefined || value === null) return "";
  if (typeof value === "string") return value.trim();
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function renderBufferItem(item: BufferItem) {
  if (item.kind !== "tool") return item.text;
  const parts: string[] = [];
  const toolName = item.toolName ?? "tool";
  if (item.toolArgs) {
    parts.push(`[Tool Call: ${toolName}]`, item.toolArgs);
  }
  if (item.toolResult) {
    parts.push(`[Tool Result: ${toolName}]`, item.toolResult);
  }
  if (!parts.length && item.text) {
    parts.push(item.text);
  }
  return parts.join("\n");
}

function countBufferItemTokens(item: BufferItem) {
  return countStringTokens(renderBufferItem(item));
}

function countStoredMemoryTokens(memory: OmStateV5["memory"]) {
  const parts = [
    memory.observations,
    memory.currentTask,
    memory.suggestedResponse,
  ].filter(Boolean);
  return countStringTokens(parts.join("\n"));
}

function refreshStateTokenEstimates(state: OmStateV5) {
  state.buffer.items = state.buffer.items.map((item) => ({
    ...item,
    tokenEstimate: countBufferItemTokens(item),
  }));
  state.buffer.tokenEstimateTotal = state.buffer.items.reduce(
    (total, entry) => total + entry.tokenEstimate,
    0,
  );
  state.memory.tokenEstimate = countStoredMemoryTokens(state.memory);
}

function isOmTool(toolID: string) {
  return (
    toolID === "om_observe" ||
    toolID === "om_reflect" ||
    toolID === "om_status" ||
    toolID === "om_export" ||
    toolID === "om_forget"
  );
}

function appendBufferItem(state: OmStateV5, item: BufferItem) {
  if (!item.text) return;
  item.tokenEstimate = countBufferItemTokens(item);
  if (
    state.buffer.items.some(
      (existing) => existing.kind === item.kind && existing.id === item.id,
    )
  )
    return;
  state.buffer.items.push(item);
  state.buffer.items.sort((a, b) => a.atMs - b.atMs);
  state.buffer.tokenEstimateTotal = state.buffer.items.reduce(
    (total, entry) => total + entry.tokenEstimate,
    0,
  );
}

function recordAssistantEvent(
  state: OmStateV5,
  input: {
    reason: AssistantEventReason;
    messageID: string;
    completed: boolean;
    summary: boolean;
    textChars?: number;
  },
) {
  state.stats.assistantEventsSeen += 1;
  state.runtime.lastAssistantEventReason = input.reason;
  state.runtime.lastAssistantEventMessageID = input.messageID;
  state.runtime.lastAssistantEventAtMs = Date.now();
  state.runtime.lastAssistantEventCompleted = input.completed;
  state.runtime.lastAssistantEventSummary = input.summary;
  state.runtime.lastAssistantEventTextChars = input.textChars ?? 0;

  if (input.reason === "captured") {
    state.stats.assistantEventsCaptured += 1;
    return;
  }

  state.stats.assistantEventsDropped += 1;
  if (input.reason === "missing-completed") {
    state.stats.assistantDropMissingCompleted += 1;
    return;
  }
  if (input.reason === "summary") {
    state.stats.assistantDropSummary += 1;
    return;
  }
  if (input.reason === "message-missing") {
    state.stats.assistantDropMessageMissing += 1;
    return;
  }
  if (input.reason === "empty-text") {
    state.stats.assistantDropEmptyText += 1;
    return;
  }
  state.stats.assistantDropDuplicate += 1;
}

async function ensureMemoryReady(
  sessionID: string,
  directory: string,
  config: OmConfig,
  thresholds: Thresholds,
  report: (message: string, extra?: Record<string, unknown>) => Promise<void>,
) {
  return withState(
    sessionID,
    directory,
    async (state) => {
      evaluateFlags(state, thresholds);
      const requiredTool = selectMaintenanceTool(state);

      if (config.mode === "deterministic") {
        if (requiredTool === "om_observe") {
          await report("Context limit reached. Observing recent history...", {
            observableBufferTokens: observableBufferTokenTotal(state),
          });
          state = runDeterministicObserve(state, config, thresholds, {
            force: true,
          });
          evaluateFlags(state, thresholds);
        }
        if (!state.flags.observeRequired && state.flags.reflectRequired) {
          await report("Compressing memory before continuing...", {
            memoryTokens: state.memory.tokenEstimate,
          });
          state = runDeterministicReflect(state, { force: true });
          evaluateFlags(state, thresholds);
        }
        if (state.flags.observeRequired || state.flags.reflectRequired) {
          state.flags.maintenanceDeferred = true;
          state.stats.maintenanceDeferredTurns += 1;
          await report(
            "Memory maintenance deferred. Continuing with raw context.",
            {
              observeRequired: state.flags.observeRequired,
              reflectRequired: state.flags.reflectRequired,
              mode: config.mode,
            },
          );
        } else {
          state.flags.maintenanceDeferred = false;
          state.runtime.maintenancePromptIssued = false;
          state.runtime.pendingMaintenanceTool = undefined;
          state.runtime.observeCursorHint = undefined;
          setToolDefinitionHint(undefined);
        }
        return state;
      }

      if (requiredTool === "om_observe") {
        const observeInput = buildObserveInput(state, config);
        state.runtime.observeCursorHint = observeInput.lastIncludedAnchor;
        if (
          state.runtime.maintenancePromptIssued &&
          state.runtime.pendingMaintenanceTool === "om_observe"
        ) {
          state.flags.maintenanceDeferred = true;
          state.stats.maintenanceDeferredTurns += 1;
        } else {
          state.flags.maintenanceDeferred = false;
        }
        state.runtime.maintenancePromptIssued = true;
        state.runtime.pendingMaintenanceTool = "om_observe";
        setToolDefinitionHint("om_observe");
        await report("Context limit reached. Observing recent history...", {
          observableBufferTokens: observableBufferTokenTotal(state),
          observeInputTokens: observeInput.tokenEstimate,
          observeInputAnchors: observeInput.anchorCount,
          mode: config.mode,
        });
        return state;
      }

      state.runtime.observeCursorHint = undefined;

      if (requiredTool === "om_reflect") {
        if (
          state.runtime.maintenancePromptIssued &&
          state.runtime.pendingMaintenanceTool === "om_reflect"
        ) {
          state.flags.maintenanceDeferred = true;
          state.stats.maintenanceDeferredTurns += 1;
        } else {
          state.flags.maintenanceDeferred = false;
        }
        state.runtime.maintenancePromptIssued = true;
        state.runtime.pendingMaintenanceTool = "om_reflect";
        setToolDefinitionHint("om_reflect");
        await report("Compressing memory before continuing...", {
          memoryTokens: state.memory.tokenEstimate,
          mode: config.mode,
        });
        return state;
      }

      state.flags.maintenanceDeferred = false;
      state.runtime.maintenancePromptIssued = false;
      state.runtime.pendingMaintenanceTool = undefined;
      state.runtime.observeCursorHint = undefined;
      setToolDefinitionHint(undefined);
      return state;
    },
    async () => {
      await report(
        "Observational memory is in passive mode because another process owns this session.",
        {
          lockContention: true,
        },
      );
    },
  );
}

function runDeterministicObserve(
  state: OmStateV5,
  config: OmConfig,
  thresholds: Thresholds,
  options: { force: boolean },
) {
  const completedAnchors = orderedCompletedAnchorIDs(state.buffer.items);
  if (!completedAnchors.length && !options.force) {
    state.flags.observeRequired = false;
    return state;
  }
  const observedItems = state.buffer.items.filter((item) =>
    completedAnchors.includes(item.turnAnchorMessageID),
  );
  if (!observedItems.length) {
    state.flags.observeRequired = false;
    return state;
  }

  const grouped = groupBufferItemsByAnchor(observedItems);
  const chunks = Array.from(grouped.entries())
    .map(([anchor, items]) =>
      summarizeObservedTurn(anchor, items, config.toolOutputChars),
    )
    .filter(Boolean);

  const merged = mergeObservationTexts(
    state.memory.observations,
    chunks.join("\n"),
    config,
  );
  const currentTask = inferCurrentTask(state, config.maxTaskChars);

  state.memory.observations = merged;
  state.memory.currentTask = currentTask || undefined;
  state.memory.suggestedResponse = undefined;
  state.memory.tokenEstimate = countStoredMemoryTokens(state.memory);
  state.memory.updatedAtMs = Date.now();
  state.lastObserved.turnAnchorMessageID = completedAnchors.at(-1);
  state.lastObserved.atMs = observedItems[observedItems.length - 1]?.atMs;
  state.stats.totalObservedItems += observedItems.length;
  state.buffer.items = state.buffer.items.filter(
    (item) => !completedAnchors.includes(item.turnAnchorMessageID),
  );
  state.buffer.tokenEstimateTotal = state.buffer.items.reduce(
    (total, item) => total + item.tokenEstimate,
    0,
  );
  state.flags.observeRequired = false;
  state.runtime.observeCursorHint = undefined;
  return state;
}

function runDeterministicReflect(
  state: OmStateV5,
  options: { force: boolean },
) {
  if (!state.memory.observations && !options.force) {
    state.flags.reflectRequired = false;
    return state;
  }
  const lines = sanitizeObservationText(
    state.memory.observations,
    Number.MAX_SAFE_INTEGER,
  )
    .split("\n")
    .filter(Boolean);
  const compacted = dedupeLines(lines).slice(-12);
  state.memory.observations = compacted.join("\n");
  state.memory.tokenEstimate = countStoredMemoryTokens(state.memory);
  state.memory.updatedAtMs = Date.now();
  state.stats.totalReflections += 1;
  state.flags.reflectRequired = false;
  return state;
}

function applyObserveToolResult(
  state: OmStateV5,
  config: OmConfig,
  args: {
    observations: string;
    currentTask?: string;
    suggestedResponse?: string;
    confirmObservedThrough?: string;
  },
) {
  const thresholds = resolveThresholds(config, DEFAULT_CONTEXT_LIMIT, state);
  evaluateFlags(state, thresholds);
  const requiredTool = selectMaintenanceTool(state);
  if (config.mode === "llm" && requiredTool && requiredTool !== "om_observe") {
    state.stats.observeFailures += 1;
    state.flags.maintenanceDeferred = true;
    return state;
  }

  const sanitized = sanitizeObserveArgs(args, config);
  if (
    !sanitized.observations ||
    detectDegenerateRepetition(sanitized.observations) ||
    !hasMeaningfulObservationContent(sanitized.observations)
  ) {
    state.stats.observeFailures += 1;
    state.flags.maintenanceDeferred = true;
    return state;
  }

  const completedAnchors = orderedCompletedAnchorIDs(state.buffer.items);
  if (!completedAnchors.length) {
    state.flags.observeRequired = false;
    state.flags.maintenanceDeferred = false;
    state.runtime.maintenancePromptIssued = false;
    state.runtime.pendingMaintenanceTool = undefined;
    state.runtime.observeCursorHint = undefined;
    return state;
  }

  const confirmObservedThrough =
    sanitized.confirmObservedThrough || state.runtime.observeCursorHint
      ? truncateText(
          (
            sanitized.confirmObservedThrough ||
            state.runtime.observeCursorHint ||
            ""
          ).trim(),
          MAX_CURSOR_HINT_CHARS,
        )
      : undefined;

  const finalAnchor =
    confirmObservedThrough && completedAnchors.includes(confirmObservedThrough)
      ? confirmObservedThrough
      : state.runtime.observeCursorHint &&
          completedAnchors.includes(state.runtime.observeCursorHint)
        ? state.runtime.observeCursorHint
        : completedAnchors.at(-1);

  const lastAnchorIndex = finalAnchor
    ? completedAnchors.indexOf(finalAnchor)
    : completedAnchors.length - 1;
  const anchorsToApply = completedAnchors.slice(0, lastAnchorIndex + 1);
  const observedItems = state.buffer.items.filter((item) =>
    anchorsToApply.includes(item.turnAnchorMessageID),
  );
  if (!observedItems.length) {
    state.stats.observeFailures += 1;
    state.flags.maintenanceDeferred = true;
    return state;
  }

  state.memory.observations = mergeObservationTexts(
    state.memory.observations,
    sanitized.observations,
    config,
  );
  state.memory.currentTask = sanitized.currentTask;
  state.memory.suggestedResponse = sanitized.suggestedResponse;
  state.memory.tokenEstimate = countStoredMemoryTokens(state.memory);
  state.memory.updatedAtMs = Date.now();
  state.lastObserved.turnAnchorMessageID = anchorsToApply.at(-1);
  state.lastObserved.atMs = observedItems[observedItems.length - 1]?.atMs;
  state.stats.totalObservedItems += observedItems.length;
  state.buffer.items = state.buffer.items.filter(
    (item) => !anchorsToApply.includes(item.turnAnchorMessageID),
  );
  state.buffer.tokenEstimateTotal = state.buffer.items.reduce(
    (total, item) => total + item.tokenEstimate,
    0,
  );
  state.flags.observeRequired = false;
  state.flags.maintenanceDeferred = false;
  state.runtime.maintenancePromptIssued = false;
  state.runtime.pendingMaintenanceTool = undefined;
  state.runtime.observeCursorHint = undefined;
  setToolDefinitionHint(undefined);
  evaluateFlags(state, thresholds);
  return state;
}

function applyReflectToolResult(
  state: OmStateV5,
  config: OmConfig,
  args: {
    observations: string;
    currentTask?: string;
    suggestedResponse?: string;
  },
) {
  const thresholds = resolveThresholds(config, DEFAULT_CONTEXT_LIMIT, state);
  evaluateFlags(state, thresholds);
  const requiredTool = selectMaintenanceTool(state);
  if (config.mode === "llm" && requiredTool && requiredTool !== "om_reflect") {
    state.stats.reflectFailures += 1;
    state.flags.maintenanceDeferred = true;
    return state;
  }

  const sanitized = sanitizeReflectArgs(args, config);
  if (
    !sanitized.observations ||
    detectDegenerateRepetition(sanitized.observations) ||
    !hasMeaningfulObservationContent(sanitized.observations)
  ) {
    state.stats.reflectFailures += 1;
    state.flags.maintenanceDeferred = true;
    return state;
  }

  const previousTokens = countStoredMemoryTokens(state.memory);
  const nextMemory = {
    ...state.memory,
    observations: sanitized.observations,
    currentTask: sanitized.hasCurrentTask ? sanitized.currentTask : undefined,
    suggestedResponse: sanitized.hasSuggestedResponse
      ? sanitized.suggestedResponse
      : undefined,
  };
  const newTokens = countStoredMemoryTokens(nextMemory);
  const targetThreshold = thresholds.reflectionThresholdTokens;
  const compressionFailed =
    state.stats.reflectFailures < 3 &&
    (newTokens > targetThreshold ||
      (previousTokens > 0 && newTokens >= previousTokens));

  if (compressionFailed) {
    state.stats.reflectFailures += 1;
    state.flags.maintenanceDeferred = true;
    return state;
  }

  state.memory.observations = sanitizeObservationText(
    sanitized.observations,
    config.maxObservationsChars,
  );
  state.memory.currentTask = sanitized.hasCurrentTask
    ? sanitized.currentTask
    : undefined;
  state.memory.suggestedResponse = sanitized.hasSuggestedResponse
    ? sanitized.suggestedResponse
    : undefined;
  state.memory.tokenEstimate = countStoredMemoryTokens(state.memory);
  state.memory.updatedAtMs = Date.now();
  state.stats.totalReflections += 1;
  state.stats.reflectFailures = 0;
  state.flags.reflectRequired = false;
  state.flags.maintenanceDeferred = false;
  state.runtime.maintenancePromptIssued = false;
  state.runtime.pendingMaintenanceTool = undefined;
  state.runtime.observeCursorHint = undefined;
  setToolDefinitionHint(undefined);
  evaluateFlags(state, thresholds);
  return state;
}

function summarizeObservedTurn(
  anchor: string,
  items: BufferItem[],
  toolOutputChars: number,
) {
  const user = items.find((item) => item.kind === "user");
  const assistant = items.findLast((item) => item.kind === "assistant");
  const tools = items.filter((item) => item.kind === "tool");
  const lines: string[] = [];
  if (user?.text) {
    lines.push(`- User asked: ${truncateText(user.text, 180)}`);
  }
  if (tools.length) {
    const toolLine = tools
      .slice(-2)
      .map((item) =>
        truncateText(
          item.text.replace(/^.*?:\s*/, ""),
          Math.min(toolOutputChars, 160),
        ),
      )
      .join(" | ");
    if (toolLine) {
      lines.push(`- Tool results: ${toolLine}`);
    }
  }
  if (assistant?.text) {
    lines.push(`- Assistant did: ${truncateText(assistant.text, 180)}`);
  }
  if (!lines.length) return "";
  return [`Turn ${anchor}:`, ...lines].join(" ");
}

function inferCurrentTask(state: OmStateV5, maxChars: number) {
  const pendingUser = [...state.buffer.items]
    .reverse()
    .find((item) => item.kind === "user");
  if (pendingUser) return truncateText(pendingUser.text, maxChars);
  const lastObservation = state.memory.observations
    .split("\n")
    .filter(Boolean)
    .at(-1);
  return lastObservation ? truncateText(lastObservation, maxChars) : "";
}

function dedupeLines(lines: string[]) {
  const seen = new Set<string>();
  const ordered: string[] = [];
  for (const line of lines) {
    if (!line) continue;
    if (seen.has(line)) continue;
    seen.add(line);
    ordered.push(line);
  }
  return ordered;
}

function completedAnchorIDs(items: BufferItem[]) {
  const anchors = new Set<string>();
  for (const item of items) {
    if (item.kind === "assistant") anchors.add(item.turnAnchorMessageID);
  }
  return anchors;
}

function orderedCompletedAnchorIDs(items: BufferItem[]) {
  const completed = completedAnchorIDs(items);
  const ordered: string[] = [];
  for (const item of items) {
    if (!completed.has(item.turnAnchorMessageID)) continue;
    if (ordered.includes(item.turnAnchorMessageID)) continue;
    ordered.push(item.turnAnchorMessageID);
  }
  return ordered;
}

function observableBufferItems(items: BufferItem[]) {
  const completed = completedAnchorIDs(items);
  return items.filter((item) => completed.has(item.turnAnchorMessageID));
}

function observableBufferTokenTotal(state: OmStateV5) {
  return observableBufferItems(state.buffer.items).reduce(
    (total, item) => total + item.tokenEstimate,
    0,
  );
}

function evaluateFlags(state: OmStateV5, thresholds: Thresholds) {
  state.flags.observeRequired =
    observableBufferTokenTotal(state) >= thresholds.observationThresholdTokens;
  state.flags.reflectRequired =
    state.memory.tokenEstimate >= thresholds.reflectionThresholdTokens;
}

function selectMaintenanceTool(
  state: OmStateV5,
): MaintenanceToolID | undefined {
  if (state.flags.observeRequired) return "om_observe";
  if (state.flags.reflectRequired) return "om_reflect";
  return undefined;
}

function renderOmBlock(
  memory: OmStateV5["memory"],
  config: OmConfig,
  thresholds: Thresholds,
) {
  const parts = [
    OBSERVATION_CONTEXT_PROMPT,
    "",
    "<observations>",
    escapeXml(optimizeObservationsForInjection(memory.observations, config, thresholds)),
    "</observations>",
    "",
    OBSERVATION_CONTEXT_INSTRUCTIONS,
  ];
  if (memory.currentTask) {
    parts.push("", "<current-task>", escapeXml(memory.currentTask), "</current-task>");
  }
  if (memory.suggestedResponse) {
    parts.push(
      "",
      "<suggested-response>",
      escapeXml(memory.suggestedResponse),
      "</suggested-response>",
    );
  }
  return parts.join("\n");
}

function renderTaskHints(memory: OmStateV5["memory"]) {
  const parts: string[] = [];
  if (memory.currentTask) {
    parts.push(
      "<current-task>",
      escapeXml(memory.currentTask),
      "</current-task>",
    );
  }
  if (memory.suggestedResponse) {
    parts.push(
      "<suggested-response>",
      escapeXml(memory.suggestedResponse),
      "</suggested-response>",
    );
  }
  return parts.join("\n");
}

function renderObserveMaintenanceBlock(state: OmStateV5, config: OmConfig) {
  const observeInput = buildObserveInput(state, config);
  const previousObservations = state.memory.observations || "None.";
  const cursorHint = observeInput.lastIncludedAnchor
    ? `Set confirmObservedThrough to "${observeInput.lastIncludedAnchor}" unless you intentionally observed an earlier completed turn boundary.`
    : "confirmObservedThrough is optional.";

  return [
    "<system-reminder>",
    "Before answering, call om_observe exactly once.",
    "Return structured tool arguments only. Do not answer the user before the tool call.",
    "</system-reminder>",
    "<observer-instructions>",
    OBSERVER_EXTRACTION_INSTRUCTIONS,
    "",
    OBSERVER_OUTPUT_FORMAT,
    "",
    "Guidelines:",
    OBSERVER_GUIDELINES,
    "",
    "Tool args:",
    "- observations: string containing only the <observations> content, without wrapper tags",
    "- currentTask: optional string containing only the <current-task> content",
    "- suggestedResponse: optional string containing only the <suggested-response> content",
    `- confirmObservedThrough: optional completed turn anchor cursor hint. ${cursorHint}`,
    "</observer-instructions>",
    "<previous-observations>",
    escapeXml(previousObservations),
    "</previous-observations>",
    "<new-history-to-observe>",
    escapeXml(
      observeInput.formatted ||
        "No completed turn groups are ready to observe.",
    ),
    "</new-history-to-observe>",
  ].join("\n");
}

function renderReflectMaintenanceBlock(state: OmStateV5) {
  const retryLevel = Math.min(state.stats.reflectFailures, 3) as 0 | 1 | 2 | 3;
  const guidance = COMPRESSION_GUIDANCE[retryLevel];

  return [
    "<system-reminder>",
    "Before answering, call om_reflect exactly once.",
    "Return structured tool arguments only. Do not answer the user before the tool call.",
    "</system-reminder>",
    "<reflector-instructions>",
    REFLECTOR_INSTRUCTIONS,
    "",
    OBSERVER_OUTPUT_FORMAT,
    "",
    "Tool args:",
    "- observations: required replacement observations string without <observations> wrapper tags",
    "- currentTask: optional replacement current task",
    "- suggestedResponse: optional replacement suggested response",
    "</reflector-instructions>",
    "<observations-to-reflect>",
    escapeXml(state.memory.observations || "No durable observations yet."),
    "</observations-to-reflect>",
    guidance
      ? `\n<compression-guidance>\n${guidance}\n</compression-guidance>`
      : "",
  ].join("\n");
}

function renderContinuationHint() {
  return `<system-reminder>${OBSERVATION_CONTINUATION_HINT}</system-reminder>`;
}

function escapeXml(text: string) {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function buildObserveInput(state: OmStateV5, config: OmConfig): ObserveInput {
  const groups = groupBufferItemsByAnchor(
    observableBufferItems(state.buffer.items),
  );
  const sections: string[] = [];
  let lastIncludedAnchor: string | undefined;
  let itemCount = 0;

  for (const [anchor, items] of groups.entries()) {
    const section = formatObservedTurnGroup(anchor, items);
    const next = sections.length
      ? `${sections.join("\n\n")}\n\n${section}`
      : section;
    if (sections.length > 0 && next.length > config.maxObserveInputChars) {
      break;
    }
    if (!sections.length && next.length > config.maxObserveInputChars) {
      sections.push(truncateWithNotice(section, config.maxObserveInputChars));
      lastIncludedAnchor = anchor;
      itemCount += items.length;
      break;
    }
    sections.push(section);
    lastIncludedAnchor = anchor;
    itemCount += items.length;
  }

  const formatted = sections.join("\n\n");
  return {
    formatted,
    lastIncludedAnchor,
    anchorCount: sections.length,
    itemCount,
    tokenEstimate: countStringTokens(formatted),
  };
}

function groupBufferItemsByAnchor(items: BufferItem[]) {
  const grouped = new Map<string, BufferItem[]>();
  for (const item of items) {
    const existing = grouped.get(item.turnAnchorMessageID) ?? [];
    existing.push(item);
    grouped.set(item.turnAnchorMessageID, existing);
  }
  return new Map(
    [...grouped.entries()]
      .map(
        ([anchor, groupedItems]) =>
          [anchor, groupedItems.toSorted((a, b) => a.atMs - b.atMs)] as const,
      )
      .toSorted((a, b) => (a[1][0]?.atMs ?? 0) - (b[1][0]?.atMs ?? 0)),
  );
}

function formatObservedTurnGroup(_anchor: string, items: BufferItem[]) {
  return items
    .map((item) => {
      const role = labelForBufferKind(item.kind);
      const timestamp = formatObserverTimestamp(item.atMs);
      return `**${role} (${timestamp}):**\n${renderBufferItem(item)}`;
    })
    .join("\n\n---\n\n");
}

function labelForBufferKind(kind: BufferKind) {
  if (kind === "user") return "User";
  if (kind === "assistant") return "Assistant";
  return "Tool";
}

function formatObserverTimestamp(atMs: number) {
  return new Date(atMs).toLocaleString(DEFAULT_LOCALE, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  });
}

function parseObservationGroups(text: string) {
  const groups: ObservationGroup[] = [];
  let current: ObservationGroup = { lines: [] };

  for (const rawLine of text.replace(/\r/g, "").split("\n")) {
    const line = rawLine.replace(/[ \t]+$/g, "");
    if (!line.trim()) continue;
    if (/^Date:\s+/i.test(line)) {
      if (current.header || current.lines.length) groups.push(current);
      current = { header: line.trim(), lines: [] };
      continue;
    }
    current.lines.push(line);
  }

  if (current.header || current.lines.length) groups.push(current);
  return groups;
}

function mergeObservationTexts(
  existing: string,
  incoming: string,
  config: OmConfig,
) {
  const order: string[] = [];
  const merged = new Map<string, ObservationGroup>();

  for (const source of [existing, incoming]) {
    for (const group of parseObservationGroups(source)) {
      const key = group.header ? `date:${group.header}` : "ungrouped";
      if (!merged.has(key)) {
        merged.set(key, { header: group.header, lines: [] });
        order.push(key);
      }
      const target = merged.get(key)!;
      const seen = new Set(target.lines);
      for (const line of group.lines) {
        if (seen.has(line)) continue;
        seen.add(line);
        target.lines.push(line);
      }
    }
  }

  return truncateText(
    renderObservationGroups(
    order.map((key) => merged.get(key)!).filter(Boolean),
    ),
    config.maxObservationsChars,
  );
}

function renderObservationGroups(groups: ObservationGroup[]) {
  return groups
    .filter((group) => group.header || group.lines.length)
    .map((group) => {
      const lines = [];
      if (group.header) lines.push(group.header);
      lines.push(...dedupeLines(group.lines));
      return lines.join("\n").trim();
    })
    .filter(Boolean)
    .join("\n")
    .trim();
}

function trimObservationGroups(
  text: string,
  config: OmConfig,
  thresholds: Thresholds,
) {
  const groups = parseObservationGroups(text);
  if (!groups.length) {
    return truncateText(text.trim(), config.maxObservationsChars);
  }

  const softTargetTokens = Math.floor(
    thresholds.reflectionThresholdTokens * 0.75,
  );
  const working = [...groups];

  while (
    working.length > 1 &&
    (countStringTokens(renderObservationGroups(working)) > softTargetTokens ||
      renderObservationGroups(working).length > config.maxObservationsChars ||
      countObservationLines(working) > MAX_OBSERVATION_LINES)
  ) {
    working.shift();
  }

  if (working.length === 1) {
    const single = working[0]!;
    while (
      single.lines.length > 1 &&
      countObservationLines(working) > MAX_OBSERVATION_LINES
    ) {
      single.lines.shift();
    }
    while (
      single.lines.length > 1 &&
      (countStringTokens(renderObservationGroups(working)) >
        softTargetTokens ||
        renderObservationGroups(working).length > config.maxObservationsChars)
    ) {
      single.lines.shift();
    }
  }

  return truncateText(
    renderObservationGroups(working),
    config.maxObservationsChars,
  );
}

function countObservationLines(groups: ObservationGroup[]) {
  return groups.reduce(
    (total, group) => total + group.lines.length + (group.header ? 1 : 0),
    0,
  );
}

function sanitizeObserveArgs(
  args: {
    observations: string;
    currentTask?: string;
    suggestedResponse?: string;
    confirmObservedThrough?: string;
  },
  config: OmConfig,
): SanitizedObserveArgs {
  return {
    observations: sanitizeObservationText(
      args.observations,
      config.maxObservationsChars,
    ),
    currentTask: sanitizeTextField(
      args.currentTask,
      "current-task",
      config.maxTaskChars,
    ),
    suggestedResponse: sanitizeTextField(
      args.suggestedResponse,
      "suggested-response",
      config.maxSuggestedResponseChars,
    ),
    confirmObservedThrough: sanitizeSingleLineField(
      args.confirmObservedThrough,
      MAX_CURSOR_HINT_CHARS,
    ),
  };
}

function sanitizeReflectArgs(
  args: {
    observations: string;
    currentTask?: string;
    suggestedResponse?: string;
  },
  config: OmConfig,
): SanitizedReflectArgs {
  return {
    observations: sanitizeObservationText(
      args.observations,
      config.maxObservationsChars,
    ),
    currentTask: sanitizeTextField(
      args.currentTask,
      "current-task",
      config.maxTaskChars,
    ),
    suggestedResponse: sanitizeTextField(
      args.suggestedResponse,
      "suggested-response",
      config.maxSuggestedResponseChars,
    ),
    hasCurrentTask: Object.prototype.hasOwnProperty.call(args, "currentTask"),
    hasSuggestedResponse: Object.prototype.hasOwnProperty.call(
      args,
      "suggestedResponse",
    ),
  };
}

function sanitizeObservationText(text: string, maxChars: number) {
  const content = stripWrappedTag(text, "observations") ?? text;
  const lines = content
    .replace(/\r/g, "")
    .split("\n")
    .map((line) => line.replace(/[ \t]+$/g, ""))
    .filter((line) => line.trim())
    .map((line) =>
      line.length > MAX_OBSERVATION_LINE_CHARS
        ? `${line.slice(0, MAX_OBSERVATION_LINE_CHARS)} … [truncated]`
        : line,
    );
  return truncateText(lines.join("\n").trim(), maxChars);
}

function sanitizeTextField(
  text: string | undefined,
  tag: string,
  maxChars: number,
) {
  if (text === undefined) return undefined;
  const stripped = stripWrappedTag(text, tag) ?? text;
  const lines = dedupeLines(
    stripped
      .replace(/\r/g, "")
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean),
  );
  const joined = truncateText(lines.join("\n"), maxChars).trim();
  return joined || undefined;
}

function sanitizeSingleLineField(text: string | undefined, maxChars: number) {
  if (!text) return undefined;
  const normalized = normalizeText(text);
  if (!normalized) return undefined;
  return truncateText(normalized, maxChars);
}

function stripWrappedTag(text: string, tag: string) {
  const direct = text.match(
    new RegExp(`^\\s*<${tag}>([\\s\\S]*?)<\\/${tag}>\\s*$`, "i"),
  );
  if (direct?.[1] !== undefined) return direct[1].trim();
  const nested = text.match(new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`, "i"));
  if (nested?.[1] !== undefined) return nested[1].trim();
  return undefined;
}

function hasMeaningfulObservationContent(text: string) {
  return text
    .split("\n")
    .some((line) => Boolean(line.trim()) && !/^Date:\s+/i.test(line.trim()));
}

function detectDegenerateRepetition(text: string) {
  if (!text || text.length < 2000) return false;

  const windowSize = 200;
  const step = Math.max(1, Math.floor(text.length / 50));
  const seen = new Map<string, number>();
  let duplicateWindows = 0;
  let totalWindows = 0;

  for (let i = 0; i + windowSize <= text.length; i += step) {
    const window = text.slice(i, i + windowSize);
    totalWindows += 1;
    const count = (seen.get(window) ?? 0) + 1;
    seen.set(window, count);
    if (count > 1) duplicateWindows += 1;
  }

  if (totalWindows > 5 && duplicateWindows / totalWindows > 0.4) return true;

  for (const line of text.split("\n")) {
    if (line.length > 50_000) return true;
  }

  return false;
}

function getSessionIDFromMessages(
  messages: Array<{
    info?: { sessionID?: string; role?: string; id?: string };
    parts?: Array<{ type?: string; text?: string }>;
  }>,
) {
  return messages.find((message) => message.info?.sessionID)?.info?.sessionID;
}

function countMessageTokens(message: {
  info: { id: string; role: string; sessionID: string };
  parts: Array<{ type?: string; text?: string }>;
}) {
  return tokenCounter.inspectMessages([message]).tokens;
}

function extractToolArguments(input: Record<string, unknown>) {
  const candidate =
    input.args ??
    input.input ??
    input.parameters ??
    input.argument ??
    input.arguments;
  return candidate;
}

function resolveThresholdValue(
  explicit: number | undefined,
  range: ThresholdRange | undefined,
  fallback: number,
) {
  let value = explicit ?? fallback;
  if (range?.min !== undefined) value = Math.max(value, range.min);
  if (range?.max !== undefined) value = Math.min(value, range.max);
  return Math.max(MIN_THRESHOLD_TOKENS, Math.floor(value));
}

function optimizeObservationsForInjection(
  observations: string,
  config: OmConfig,
  thresholds: Thresholds,
) {
  if (!observations) return "No durable observations yet.";
  let optimized = trimObservationGroups(observations, config, thresholds);
  if (config.relativeTimeAnnotations) {
    optimized = addRelativeTimeToObservations(
      optimized,
      new Date(),
      config.relativeTimeLocale,
      config.relativeTimeTimeZone,
    );
  }
  return optimized;
}

function zonedDayStamp(date: Date, timeZone?: string) {
  if (!timeZone) {
    return Date.UTC(date.getFullYear(), date.getMonth(), date.getDate());
  }
  const parts = new Intl.DateTimeFormat(DEFAULT_LOCALE, {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const year = Number(parts.find((part) => part.type === "year")?.value ?? date.getFullYear());
  const month = Number(parts.find((part) => part.type === "month")?.value ?? date.getMonth() + 1);
  const day = Number(parts.find((part) => part.type === "day")?.value ?? date.getDate());
  return Date.UTC(year, month - 1, day);
}

function formatRelativeTime(date: Date, currentDate: Date, timeZone?: string) {
  const diffMs = zonedDayStamp(currentDate, timeZone) - zonedDayStamp(date, timeZone);
  const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));

  if (diffDays === 0) return "today";
  if (diffDays === 1) return "yesterday";
  if (diffDays < 7) return `${diffDays} days ago`;
  if (diffDays < 14) return "1 week ago";
  if (diffDays < 30) return `${Math.floor(diffDays / 7)} weeks ago`;
  if (diffDays < 60) return "1 month ago";
  if (diffDays < 365) return `${Math.floor(diffDays / 30)} months ago`;
  const years = Math.floor(diffDays / 365);
  return `${years} year${years > 1 ? "s" : ""} ago`;
}

function formatGapBetweenDates(prevDate: Date, currDate: Date, timeZone?: string) {
  const diffDays = Math.floor(
    (zonedDayStamp(currDate, timeZone) - zonedDayStamp(prevDate, timeZone)) /
      (1000 * 60 * 60 * 24),
  );
  if (diffDays <= 1) return null;
  if (diffDays < 7) return `[${diffDays} days later]`;
  if (diffDays < 14) return "[1 week later]";
  if (diffDays < 30) return `[${Math.floor(diffDays / 7)} weeks later]`;
  if (diffDays < 60) return "[1 month later]";
  return `[${Math.floor(diffDays / 30)} months later]`;
}

function parseDateFromContent(dateContent: string) {
  const simpleDateMatch = dateContent.match(/([A-Z][a-z]+)\s+(\d{1,2}),?\s+(\d{4})/);
  if (simpleDateMatch) {
    const parsed = new Date(`${simpleDateMatch[1]} ${simpleDateMatch[2]}, ${simpleDateMatch[3]}`);
    if (!Number.isNaN(parsed.getTime())) return parsed;
  }
  const rangeMatch = dateContent.match(/([A-Z][a-z]+)\s+(\d{1,2})-\d{1,2},?\s+(\d{4})/);
  if (rangeMatch) {
    const parsed = new Date(`${rangeMatch[1]} ${rangeMatch[2]}, ${rangeMatch[3]}`);
    if (!Number.isNaN(parsed.getTime())) return parsed;
  }
  const vagueMatch = dateContent.match(
    /(late|early|mid)[- ]?(?:to[- ]?(?:late|early|mid)[- ]?)?([A-Z][a-z]+)\s+(\d{4})/i,
  );
  if (vagueMatch) {
    const day = vagueMatch[1]?.toLowerCase() === "early" ? 7 : vagueMatch[1]?.toLowerCase() === "late" ? 23 : 15;
    const parsed = new Date(`${vagueMatch[2]} ${day}, ${vagueMatch[3]}`);
    if (!Number.isNaN(parsed.getTime())) return parsed;
  }
  return null;
}

function isFutureIntentObservation(line: string) {
  return [
    /\bwill\s+(?:be\s+)?(?:\w+ing|\w+)\b/i,
    /\bplans?\s+to\b/i,
    /\bplanning\s+to\b/i,
    /\blooking\s+forward\s+to\b/i,
    /\bgoing\s+to\b/i,
    /\bintends?\s+to\b/i,
    /\bwants?\s+to\b/i,
    /\bneeds?\s+to\b/i,
    /\babout\s+to\b/i,
  ].some((pattern) => pattern.test(line));
}

function expandInlineEstimatedDates(
  observations: string,
  currentDate: Date,
  timeZone?: string,
) {
  const inlineDateRegex = /\((estimated|meaning)\s+([^)]+\d{4})\)/gi;
  return observations.replace(
    inlineDateRegex,
    (match, prefix: string, dateContent: string) => {
      const targetDate = parseDateFromContent(dateContent);
      if (!targetDate) return match;
      const relative = formatRelativeTime(targetDate, currentDate, timeZone);
      const matchIndex = observations.indexOf(match);
      const lineStart = observations.lastIndexOf("\n", matchIndex) + 1;
      const lineBeforeDate = observations.substring(lineStart, matchIndex);
      if (targetDate < currentDate && isFutureIntentObservation(lineBeforeDate)) {
        return `(${prefix} ${dateContent} - ${relative}, likely already happened)`;
      }
      return `(${prefix} ${dateContent} - ${relative})`;
    },
  );
}

function addRelativeTimeToObservations(
  observations: string,
  currentDate: Date,
  locale: string,
  timeZone?: string,
) {
  const withInlineDates = expandInlineEstimatedDates(
    observations,
    currentDate,
    timeZone,
  );
  const dateHeaderRegex = /^(Date:\s*)([A-Z][a-z]+ \d{1,2}, \d{4})$/gm;
  const dates: Array<{
    index: number;
    date: Date;
    match: string;
    prefix: string;
    dateStr: string;
  }> = [];
  let regexMatch: RegExpExecArray | null;
  while ((regexMatch = dateHeaderRegex.exec(withInlineDates)) !== null) {
    const dateStr = regexMatch[2]!;
    const parsed = new Date(dateStr);
    if (!Number.isNaN(parsed.getTime())) {
      dates.push({
        index: regexMatch.index,
        date: parsed,
        match: regexMatch[0],
        prefix: regexMatch[1]!,
        dateStr:
          parsed.toLocaleDateString(locale || DEFAULT_LOCALE, {
            timeZone,
            month: "short",
            day: "numeric",
            year: "numeric",
          }) || dateStr,
      });
    }
  }
  if (!dates.length) return withInlineDates;

  let result = "";
  let lastIndex = 0;
  for (let index = 0; index < dates.length; index += 1) {
    const curr = dates[index]!;
    const prev = index > 0 ? dates[index - 1]! : undefined;
    result += withInlineDates.slice(lastIndex, curr.index);
    if (prev) {
      const gap = formatGapBetweenDates(prev.date, curr.date, timeZone);
      if (gap) result += `\n${gap}\n\n`;
    }
    result += `${curr.prefix}${curr.dateStr} (${formatRelativeTime(curr.date, currentDate, timeZone)})`;
    lastIndex = curr.index + curr.match.length;
  }
  result += withInlineDates.slice(lastIndex);
  return result;
}

function pruneMessages(
  messages: Array<{
    info: { id: string; role: string; sessionID: string };
    parts: Array<{ type?: string; text?: string }>;
  }>,
  state: OmStateV5,
  thresholds: Thresholds,
  requiredTool?: MaintenanceToolID,
  transformedMessages = tokenCounter.inspectMessages(messages),
) {
  if (requiredTool || state.flags.maintenanceDeferred) {
    return {
      messages,
      pruned: false,
      continuationHint: false,
      shouldInject: false,
      pruneCutoffAnchor: undefined,
      protectedTailAnchor: undefined,
      retainedTailTokens: 0,
      rawBudgetApplied: false,
    };
  }

  const userIndexes = messages.flatMap((message, index) =>
    message.info.role === "user" ? [index] : [],
  );
  if (userIndexes.length < RECENT_USER_PROTECTION + 1) {
    return {
      messages,
      pruned: false,
      continuationHint: false,
      shouldInject: !!state.memory.observations,
      pruneCutoffAnchor: undefined,
      protectedTailAnchor: undefined,
      retainedTailTokens: transformedMessages.tokens,
      rawBudgetApplied: false,
    };
  }
  if (!state.lastObserved.turnAnchorMessageID || !state.memory.observations) {
    return {
      messages,
      pruned: false,
      continuationHint: false,
      shouldInject: false,
      pruneCutoffAnchor: undefined,
      protectedTailAnchor: undefined,
      retainedTailTokens: transformedMessages.tokens,
      rawBudgetApplied: false,
    };
  }

  const protectedStartIndex =
    userIndexes[
      Math.max(
        0,
        userIndexes.length - Math.max(RECENT_USER_PROTECTION, thresholds.tailRetentionUserTurns),
      )
    ];
  const protectedStartID = messages[protectedStartIndex]?.info.id;
  if (!protectedStartID) {
    return {
      messages,
      pruned: false,
      continuationHint: false,
      shouldInject: false,
      pruneCutoffAnchor: undefined,
      protectedTailAnchor: undefined,
      retainedTailTokens: transformedMessages.tokens,
      rawBudgetApplied: false,
    };
  }

  const anchors = userIndexes.map((index) => messages[index]!.info.id);
  const observedIndex = anchors.indexOf(state.lastObserved.turnAnchorMessageID);
  if (observedIndex === -1) {
    return {
      messages,
      pruned: false,
      continuationHint: false,
      shouldInject: false,
      pruneCutoffAnchor: undefined,
      protectedTailAnchor: protectedStartID,
      retainedTailTokens: transformedMessages.tokens,
      rawBudgetApplied: false,
    };
  }

  const cutoffAnchorIndex = Math.min(
    observedIndex,
    userIndexes.length - thresholds.tailRetentionUserTurns - 1,
  );
  if (cutoffAnchorIndex < 0) {
    return {
      messages,
      pruned: false,
      continuationHint: false,
      shouldInject: true,
      pruneCutoffAnchor: undefined,
      protectedTailAnchor: protectedStartID,
      retainedTailTokens: transformedMessages.tokens,
      rawBudgetApplied: false,
    };
  }

  let keepFromIndex = userIndexes[cutoffAnchorIndex + 1] ?? 0;
  if (thresholds.tailRetentionTokens) {
    let retainedTokens = 0;
    let tokenTailIndex = messages.length;
    while (tokenTailIndex > 0 && retainedTokens < thresholds.tailRetentionTokens) {
      tokenTailIndex -= 1;
      retainedTokens += countMessageTokens(messages[tokenTailIndex]);
    }
    keepFromIndex = Math.min(keepFromIndex, tokenTailIndex);
  }

  const pruned = messages.slice(keepFromIndex);
  const retainedTailTokens = tokenCounter.inspectMessages(pruned).tokens;
  return {
    messages: pruned,
    pruned: pruned.length < messages.length,
    continuationHint: pruned.length < messages.length,
    shouldInject: true,
    pruneCutoffAnchor: anchors[cutoffAnchorIndex],
    protectedTailAnchor: protectedStartID,
    retainedTailTokens,
    rawBudgetApplied: false,
  };
}

function resolveThresholds(
  config: OmConfig,
  contextLimit: number,
  state?: OmStateV5,
): Thresholds {
  const rawMessageBudgetTokens =
    config.rawMessageBudgetTokens ?? Math.floor(contextLimit * 0.25);
  let observationThresholdTokens = resolveThresholdValue(
    config.observeThresholdTokens,
    config.observeThresholdRange,
    Math.min(30000, Math.floor(contextLimit * 0.35)),
  );
  let reflectionThresholdTokens = resolveThresholdValue(
    config.reflectThresholdTokens,
    config.reflectThresholdRange,
    Math.min(40000, Math.floor(contextLimit * 0.5)),
  );
  const sharedBudgetTokens = config.shareTokenBudget
    ? Math.max(MIN_SHARED_BUDGET_TOKENS, contextLimit - rawMessageBudgetTokens)
    : undefined;
  if (config.shareTokenBudget) {
    const memoryTokens = state?.memory.tokenEstimate ?? 0;
    observationThresholdTokens = Math.min(
      observationThresholdTokens,
      Math.max(
        MIN_SHARED_BUDGET_TOKENS,
        contextLimit - rawMessageBudgetTokens - memoryTokens,
      ),
    );
    reflectionThresholdTokens = Math.min(
      reflectionThresholdTokens,
      sharedBudgetTokens ?? reflectionThresholdTokens,
    );
  }
  return {
    observationThresholdTokens,
    reflectionThresholdTokens,
    rawMessageBudgetTokens,
    tailRetentionUserTurns: Math.max(
      RECENT_USER_PROTECTION,
      config.tailRetentionUserTurns ?? RECENT_USER_PROTECTION,
    ),
    tailRetentionTokens: config.tailRetentionTokens,
    shareTokenBudget: config.shareTokenBudget,
    sharedBudgetTokens,
    scope: config.scope,
    observeHardOverdue: Math.floor(observationThresholdTokens * 1.5),
    reflectHardOverdue: Math.floor(reflectionThresholdTokens * 1.25),
  };
}

function statusPayload(state: OmStateV5, config: OmConfig, sessionID = state.sessionID) {
  refreshStateTokenEstimates(state);
  const thresholds = resolveThresholds(config, DEFAULT_CONTEXT_LIMIT, state);
  evaluateFlags(state, thresholds);
  const observeInput = buildObserveInput(state, config);
  const runtime = runtimeStatus.get(sessionID);
  const promptDiagnostics = runtime?.promptDiagnostics;
  const injectedMemoryTokens =
    promptDiagnostics?.injectedMemoryTokens ??
    (state.memory.observations
      ? countStringTokens(renderOmBlock(state.memory, config, thresholds))
      : 0);
  return {
    sessionID,
    mode: config.mode,
    scope: {
      mode: config.scope,
      key: state.scopeKey,
    },
    thresholds,
    current: {
      bufferTokens: state.buffer.tokenEstimateTotal,
      observableBufferTokens: observableBufferTokenTotal(state),
      memoryTokens: state.memory.tokenEstimate,
      lastObservedTurnAnchor: state.lastObserved.turnAnchorMessageID,
      maintenanceDeferred: !!state.flags.maintenanceDeferred,
      maintenanceDeferredTurns: state.stats.maintenanceDeferredTurns,
      requiredTool: selectMaintenanceTool(state),
      observeCursorHint: state.runtime.observeCursorHint,
      observeInputAnchors: observeInput.anchorCount,
      observeInputTokens: observeInput.tokenEstimate,
      tailRetentionUserTurns: thresholds.tailRetentionUserTurns,
      tailRetentionTokens: thresholds.tailRetentionTokens,
      effectiveCutoffAnchor: runtime?.pruneCutoffAnchor,
      protectedTailAnchor: runtime?.protectedTailAnchor,
      retainedTailTokens: runtime?.retainedTailTokens ?? 0,
      shareTokenBudget: thresholds.shareTokenBudget,
      sharedBudgetTokens: thresholds.sharedBudgetTokens,
      lockContention: !!state.flags.lockContention,
      lockContentionSkips: state.stats.lockContentionSkips,
      lastLockContentionAtMs: state.runtime.lastLockContentionAtMs,
      assistantCapture: {
        seen: state.stats.assistantEventsSeen,
        captured: state.stats.assistantEventsCaptured,
        dropped: state.stats.assistantEventsDropped,
        dropReasons: {
          missingCompleted: state.stats.assistantDropMissingCompleted,
          summary: state.stats.assistantDropSummary,
          messageMissing: state.stats.assistantDropMessageMissing,
          emptyText: state.stats.assistantDropEmptyText,
          duplicate: state.stats.assistantDropDuplicate,
        },
        lastEvent: {
          reason: state.runtime.lastAssistantEventReason,
          messageID: state.runtime.lastAssistantEventMessageID,
          atMs: state.runtime.lastAssistantEventAtMs,
          completed: state.runtime.lastAssistantEventCompleted,
          summary: state.runtime.lastAssistantEventSummary,
          textChars: state.runtime.lastAssistantEventTextChars,
        },
      },
      diagnostics: {
        tokenizer: promptDiagnostics?.tokenizer ?? tokenCounter.tokenizer,
        transformedMessageTokens:
          promptDiagnostics?.transformedMessages.tokens ?? 0,
        transformedCountedMessages:
          promptDiagnostics?.transformedMessages.countedMessages ?? 0,
        transformedSkippedMessages:
          promptDiagnostics?.transformedMessages.skippedMessages ?? 0,
        countedPromptParts:
          promptDiagnostics?.transformedMessages.countedParts ?? 0,
        skippedPromptParts:
          promptDiagnostics?.transformedMessages.skippedParts ?? 0,
        injectedSystemTokens: promptDiagnostics?.injectedSystemTokens ?? 0,
        injectedMemoryTokens,
        injectedTaskHintTokens:
          promptDiagnostics?.injectedTaskHintTokens ??
          countStringTokens(renderTaskHints(state.memory)),
        injectedContinuationHintTokens:
          promptDiagnostics?.injectedContinuationHintTokens ?? 0,
        injectedMaintenanceTokens:
          promptDiagnostics?.injectedMaintenanceTokens ?? 0,
        injectedReminderTokens:
          promptDiagnostics?.injectedReminderTokens ?? 0,
      },
    },
    stats: {
      totalObservedItems: state.stats.totalObservedItems,
      totalReflections: state.stats.totalReflections,
      observeFailures: state.stats.observeFailures,
      reflectFailures: state.stats.reflectFailures,
      maintenanceDeferredTurns: state.stats.maintenanceDeferredTurns,
      lockContentionSkips: state.stats.lockContentionSkips,
      assistantEventsSeen: state.stats.assistantEventsSeen,
      assistantEventsCaptured: state.stats.assistantEventsCaptured,
      assistantEventsDropped: state.stats.assistantEventsDropped,
    },
  };
}

export async function readOmStatus(sessionID: string, directory: string) {
  const [state, config, statePath] = await Promise.all([
    loadState(sessionID, directory),
    getConfig(directory),
    sessionStatePath(directory, sessionID),
  ]);
  return {
    status: statusPayload(state, config, sessionID),
    statePath,
  };
}

async function log(
  client: {
    app: {
      log: (options: {
        body: {
          service: string;
          level: "debug" | "info" | "warn" | "error";
          message: string;
          extra?: Record<string, unknown>;
        };
      }) => Promise<unknown>;
    };
  },
  level: "debug" | "info" | "warn" | "error",
  message: string,
  extra?: Record<string, unknown>,
) {
  await client.app
    .log({
      body: {
        service: PLUGIN_ID,
        level,
        message,
        extra,
      },
    })
    .catch(() => {});
}

async function forgetState(sessionID: string, directory: string) {
  const scope = await resolveScopeIdentity(directory, sessionID);
  cache.delete(scope.key);
  runtimeStatus.delete(sessionID);
  const file = await sessionStatePath(directory, sessionID);
  await fs.rm(file, { force: true }).catch(() => {});
}

async function withState(
  sessionID: string,
  directory: string,
  mutate: (
    state: OmStateV5,
    config: OmConfig,
  ) => Promise<OmStateV5> | OmStateV5,
  onLockContention?: () => Promise<void>,
) {
  const config = await getConfig(directory);
  const scope = resolveScopeIdentityFromConfig(config, directory, sessionID);
  const state = await loadState(sessionID, directory);
  const lock = await acquireLock(sessionID, directory);
  if (!lock.acquired) {
    state.flags.lockContention = true;
    state.stats.lockContentionSkips += 1;
    state.runtime.lastLockContentionAtMs = Date.now();
    cache.set(scope.key, state);
    if (onLockContention) await onLockContention();
    return state;
  }
  try {
    refreshStateTokenEstimates(state);
    const next = await mutate(state, config);
    refreshStateTokenEstimates(next);
    next.sessionID = sessionID;
    next.scopeMode = scope.mode;
    next.scopeKey = scope.key;
    next.flags.lockContention = false;
    next.generation += 1;
    await writeState(directory, next, sessionID);
    cache.set(scope.key, next);
    return next;
  } finally {
    await releaseLock(lock.path);
  }
}

async function loadState(sessionID: string, directory: string) {
  const scope = await resolveScopeIdentity(directory, sessionID);
  const cached = cache.get(scope.key);
  if (cached) return cached;
  const file = await sessionStatePath(directory, sessionID);
  try {
    const text = await fs.readFile(file, "utf8");
    const parsed = JSON.parse(text);
    const state = migrateState(sessionID, parsed, scope);
    refreshStateTokenEstimates(state);
    cache.set(scope.key, state);
    return state;
  } catch {
    const state = createEmptyState(sessionID, scope);
    cache.set(scope.key, state);
    return state;
  }
}

async function writeState(directory: string, state: OmStateV5, sessionID: string) {
  const file = await sessionStatePath(directory, sessionID);
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
  const handle = await fs.open(temp, "w");
  try {
    await handle.writeFile(`${JSON.stringify(state, null, 2)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  await fs.rename(temp, file);
}

async function acquireLock(sessionID: string, directory: string) {
  const lockPath = await sessionLockPath(directory, sessionID);
  await fs.mkdir(path.dirname(lockPath), { recursive: true });
  const now = Date.now();
  try {
    const handle = await fs.open(lockPath, "wx");
    await handle.writeFile(
      JSON.stringify({ pid: process.pid, writerInstanceID, acquiredAt: now }),
      "utf8",
    );
    await handle.close();
    return { acquired: true as const, path: lockPath };
  } catch {
    const stale = await isStaleLock(lockPath, now);
    if (stale) {
      await fs.rm(lockPath, { force: true }).catch(() => {});
      return acquireLock(sessionID, directory);
    }
    return { acquired: false as const, path: lockPath };
  }
}

async function isStaleLock(lockPath: string, now: number) {
  try {
    const stat = await fs.stat(lockPath);
    return now - stat.mtimeMs > LOCK_STALE_MS;
  } catch {
    return true;
  }
}

async function releaseLock(lockPath: string) {
  await fs.rm(lockPath, { force: true }).catch(() => {});
}

async function sessionStatePath(directory: string, sessionID: string) {
  const root = await stateDirectory(directory);
  const scope = await resolveScopeIdentity(directory, sessionID);
  return path.join(root, `${scope.key}.json`);
}

async function sessionLockPath(directory: string, sessionID: string) {
  const root = await stateDirectory(directory);
  const scope = await resolveScopeIdentity(directory, sessionID);
  return path.join(root, `${scope.key}.lock`);
}

async function resolveScopeIdentity(directory: string, sessionID: string) {
  const config = await getConfig(directory);
  return resolveScopeIdentityFromConfig(config, directory, sessionID);
}

function resolveScopeIdentityFromConfig(
  config: OmConfig,
  directory: string,
  sessionID: string,
) {
  if (config.scope === "project") {
    return {
      mode: "project" as const,
      key: `project-${hashText(path.resolve(directory))}`,
    };
  }
  if (config.scope === "global") {
    return {
      mode: "global" as const,
      key: "global",
    };
  }
  return {
    mode: "session" as const,
    key: sessionID,
  };
}

async function stateDirectory(directory: string) {
  const config = await getConfig(directory);
  if (config.stateDir) return config.stateDir;
  const xdg = process.env.XDG_STATE_HOME;
  if (xdg) return path.join(xdg, "opencode", "observational-memory");
  return path.join(
    os.homedir(),
    ".local",
    "state",
    "opencode",
    "observational-memory",
  );
}

async function getConfig(directory: string) {
  const key = directory;
  if (!configCache.has(key)) {
    configCache.set(key, loadConfig(directory));
  }
  return configCache.get(key)!;
}

async function loadConfig(directory: string): Promise<OmConfig> {
  const defaults: OmConfig = {
    enabled: true,
    mode: "llm",
    observeThresholdTokens: undefined,
    observeThresholdRange: undefined,
    reflectThresholdTokens: undefined,
    reflectThresholdRange: undefined,
    rawMessageBudgetTokens: undefined,
    tailRetentionUserTurns: RECENT_USER_PROTECTION,
    tailRetentionTokens: undefined,
    shareTokenBudget: false,
    scope: "session",
    relativeTimeAnnotations: true,
    relativeTimeLocale: DEFAULT_LOCALE,
    relativeTimeTimeZone: undefined,
    toolOutputChars: 2000,
    stateDir: "",
    maxObserveInputChars: 24000,
    maxObservationsChars: 64000,
    maxTaskChars: 2000,
    maxSuggestedResponseChars: 4000,
  };

  const globalPath = path.join(
    os.homedir(),
    ".config",
    "opencode",
    "observational-memory.json",
  );
  const projectPath = path.join(
    directory,
    ".opencode",
    "observational-memory.json",
  );
  const globalConfig = await readJson<Partial<OmConfig>>(globalPath);
  const projectConfig = await readJson<Partial<OmConfig>>(projectPath);
  const envConfig: Partial<OmConfig> = {
    enabled: parseBoolean(
      process.env.OPENCODE_OM_ENABLED,
      projectConfig.enabled ?? globalConfig.enabled ?? defaults.enabled,
    ),
    mode: parseMode(process.env.OPENCODE_OM_MODE),
    observeThresholdTokens: parseNumber(process.env.OPENCODE_OM_OBSERVE_TOKENS),
    observeThresholdRange: parseThresholdRangeFromEnv("OPENCODE_OM_OBSERVE"),
    reflectThresholdTokens: parseNumber(process.env.OPENCODE_OM_REFLECT_TOKENS),
    reflectThresholdRange: parseThresholdRangeFromEnv("OPENCODE_OM_REFLECT"),
    rawMessageBudgetTokens: parseNumber(
      process.env.OPENCODE_OM_RAW_BUDGET_TOKENS,
    ),
    tailRetentionUserTurns: parseNumber(process.env.OPENCODE_OM_TAIL_USER_TURNS),
    tailRetentionTokens: parseNumber(process.env.OPENCODE_OM_TAIL_TOKENS),
    shareTokenBudget: parseBoolean(
      process.env.OPENCODE_OM_SHARE_TOKEN_BUDGET,
      projectConfig.shareTokenBudget ??
        globalConfig.shareTokenBudget ??
        defaults.shareTokenBudget,
    ),
    scope: parseScope(process.env.OPENCODE_OM_SCOPE),
    relativeTimeAnnotations: parseBoolean(
      process.env.OPENCODE_OM_RELATIVE_TIME,
      projectConfig.relativeTimeAnnotations ??
        globalConfig.relativeTimeAnnotations ??
        defaults.relativeTimeAnnotations,
    ),
    relativeTimeLocale: process.env.OPENCODE_OM_RELATIVE_TIME_LOCALE,
    relativeTimeTimeZone: process.env.OPENCODE_OM_RELATIVE_TIME_TZ,
    toolOutputChars:
      parseNumber(process.env.OPENCODE_OM_TOOL_OUTPUT_CHARS) ?? undefined,
    stateDir: process.env.OPENCODE_OM_STATE_DIR,
    maxObserveInputChars: parseNumber(
      process.env.OPENCODE_OM_MAX_OBSERVE_INPUT_CHARS,
    ),
    maxObservationsChars: parseNumber(
      process.env.OPENCODE_OM_MAX_OBSERVATIONS_CHARS,
    ),
    maxTaskChars: parseNumber(process.env.OPENCODE_OM_MAX_TASK_CHARS),
    maxSuggestedResponseChars: parseNumber(
      process.env.OPENCODE_OM_MAX_SUGGESTED_RESPONSE_CHARS,
    ),
  };

  return {
    ...defaults,
    ...globalConfig,
    ...projectConfig,
    ...envConfig,
    enabled:
      envConfig.enabled ??
      projectConfig.enabled ??
      globalConfig.enabled ??
      defaults.enabled,
    mode:
      envConfig.mode ??
      projectConfig.mode ??
      globalConfig.mode ??
      defaults.mode,
    observeThresholdTokens:
      envConfig.observeThresholdTokens ??
      projectConfig.observeThresholdTokens ??
      globalConfig.observeThresholdTokens ??
      defaults.observeThresholdTokens,
    observeThresholdRange:
      envConfig.observeThresholdRange ??
      normalizeThresholdRange(projectConfig.observeThresholdRange) ??
      normalizeThresholdRange(globalConfig.observeThresholdRange) ??
      defaults.observeThresholdRange,
    reflectThresholdTokens:
      envConfig.reflectThresholdTokens ??
      projectConfig.reflectThresholdTokens ??
      globalConfig.reflectThresholdTokens ??
      defaults.reflectThresholdTokens,
    reflectThresholdRange:
      envConfig.reflectThresholdRange ??
      normalizeThresholdRange(projectConfig.reflectThresholdRange) ??
      normalizeThresholdRange(globalConfig.reflectThresholdRange) ??
      defaults.reflectThresholdRange,
    rawMessageBudgetTokens:
      envConfig.rawMessageBudgetTokens ??
      projectConfig.rawMessageBudgetTokens ??
      globalConfig.rawMessageBudgetTokens ??
      defaults.rawMessageBudgetTokens,
    tailRetentionUserTurns:
      envConfig.tailRetentionUserTurns ??
      projectConfig.tailRetentionUserTurns ??
      globalConfig.tailRetentionUserTurns ??
      defaults.tailRetentionUserTurns,
    tailRetentionTokens:
      envConfig.tailRetentionTokens ??
      projectConfig.tailRetentionTokens ??
      globalConfig.tailRetentionTokens ??
      defaults.tailRetentionTokens,
    shareTokenBudget:
      envConfig.shareTokenBudget ??
      projectConfig.shareTokenBudget ??
      globalConfig.shareTokenBudget ??
      defaults.shareTokenBudget,
    scope:
      envConfig.scope ??
      projectConfig.scope ??
      globalConfig.scope ??
      defaults.scope,
    relativeTimeAnnotations:
      envConfig.relativeTimeAnnotations ??
      projectConfig.relativeTimeAnnotations ??
      globalConfig.relativeTimeAnnotations ??
      defaults.relativeTimeAnnotations,
    relativeTimeLocale:
      envConfig.relativeTimeLocale ??
      projectConfig.relativeTimeLocale ??
      globalConfig.relativeTimeLocale ??
      defaults.relativeTimeLocale,
    relativeTimeTimeZone:
      envConfig.relativeTimeTimeZone ??
      projectConfig.relativeTimeTimeZone ??
      globalConfig.relativeTimeTimeZone ??
      defaults.relativeTimeTimeZone,
    toolOutputChars:
      envConfig.toolOutputChars ??
      projectConfig.toolOutputChars ??
      globalConfig.toolOutputChars ??
      defaults.toolOutputChars,
    stateDir:
      envConfig.stateDir ??
      projectConfig.stateDir ??
      globalConfig.stateDir ??
      defaults.stateDir,
    maxObserveInputChars:
      envConfig.maxObserveInputChars ??
      projectConfig.maxObserveInputChars ??
      globalConfig.maxObserveInputChars ??
      defaults.maxObserveInputChars,
    maxObservationsChars:
      envConfig.maxObservationsChars ??
      projectConfig.maxObservationsChars ??
      globalConfig.maxObservationsChars ??
      defaults.maxObservationsChars,
    maxTaskChars:
      envConfig.maxTaskChars ??
      projectConfig.maxTaskChars ??
      globalConfig.maxTaskChars ??
      defaults.maxTaskChars,
    maxSuggestedResponseChars:
      envConfig.maxSuggestedResponseChars ??
      projectConfig.maxSuggestedResponseChars ??
      globalConfig.maxSuggestedResponseChars ??
      defaults.maxSuggestedResponseChars,
  };
}

async function readJson<T>(file: string) {
  try {
    return JSON.parse(await fs.readFile(file, "utf8")) as T;
  } catch {
    return {} as T;
  }
}

function parseBoolean(value: string | undefined, fallback: boolean) {
  if (value === undefined) return fallback;
  return value === "1" || value.toLowerCase() === "true";
}

function parseNumber(value: string | undefined) {
  if (!value) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function parseMode(value: string | undefined) {
  if (value === "llm" || value === "deterministic") return value;
  return undefined;
}

function parseScope(value: string | undefined) {
  if (value === "session" || value === "project" || value === "global") {
    return value;
  }
  return undefined;
}

function normalizeThresholdRange(value: unknown): ThresholdRange | undefined {
  if (!value || typeof value !== "object") return undefined;
  const candidate = value as ThresholdRange;
  const min = typeof candidate.min === "number" ? candidate.min : undefined;
  const max = typeof candidate.max === "number" ? candidate.max : undefined;
  if (min === undefined && max === undefined) return undefined;
  return { min, max };
}

function parseThresholdRangeFromEnv(prefix: "OPENCODE_OM_OBSERVE" | "OPENCODE_OM_REFLECT") {
  const min = parseNumber(process.env[`${prefix}_MIN_TOKENS`]);
  const max = parseNumber(process.env[`${prefix}_MAX_TOKENS`]);
  if (min === undefined && max === undefined) return undefined;
  return { min, max };
}

function setToolDefinitionHint(toolID: MaintenanceToolID | undefined) {
  if (!toolID) {
    toolDefinitionHint = undefined;
    return;
  }
  toolDefinitionHint = {
    toolID,
    expiresAtMs: Date.now() + TOOL_DEFINITION_HINT_TTL_MS,
  };
}
