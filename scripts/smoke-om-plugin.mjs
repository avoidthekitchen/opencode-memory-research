#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tempStateDir = mkdtempSync(path.join(os.tmpdir(), "om-smoke-"));

try {
  process.env.OPENCODE_OM_STATE_DIR = tempStateDir;
  process.env.OPENCODE_OM_MODE = "llm";
  process.env.OPENCODE_OM_OBSERVE_MIN_TOKENS = "1";
  process.env.OPENCODE_OM_OBSERVE_MAX_TOKENS = "5";
  process.env.OPENCODE_OM_TAIL_USER_TURNS = "3";
  process.env.OPENCODE_OM_SCOPE = "project";
  process.env.OPENCODE_OM_SHARE_TOKEN_BUDGET = "true";

  if (process.argv.includes("--opencode")) {
    runOpencodeSmoke();
  } else {
    await runPluginSmoke();
  }
} finally {
  rmSync(tempStateDir, { recursive: true, force: true });
}

async function runPluginSmoke() {
  const pluginModule = await import(
    pathToFileURL(
      path.join(root, ".opencode", "plugins", "observational-memory.ts"),
    ).href
  );
  const tokenCounterModule = await import(
    pathToFileURL(
      path.join(root, ".opencode", "plugins", "token-counter.ts"),
    ).href
  );
  const { ObservationalMemoryPlugin } = pluginModule;
  const { tokenCounter } = tokenCounterModule;

  const logs = [];
  const assistantParts = [
    { type: "text", text: "Hello world back from the assistant." },
  ];
  const plugin = await ObservationalMemoryPlugin({
    client: {
      app: {
        log: async (input) => {
          logs.push(input);
          return { data: true };
        },
      },
      session: {
        message: async () => ({ data: { parts: assistantParts } }),
      },
    },
    project: { id: "proj-smoke", worktree: root },
    directory: root,
    worktree: root,
    serverUrl: new URL("http://localhost:4096"),
    $: undefined,
  });

  assertToolKeys(plugin);
  assertToolSchemas(plugin);
  const tokenSamples = buildTokenSamples(tokenCounter);

  await plugin["chat.message"](
    { sessionID: "smoke-session", messageID: "user-1" },
    {
      message: { id: "user-1" },
      parts: [{ type: "text", text: "hello world" }],
    },
  );
  await plugin["tool.execute.after"](
    {
      sessionID: "smoke-session",
      tool: "read_file",
      callID: "tool-call-1",
      args: { path: "/tmp/example.ts" },
    },
    {
      output: "const value = 42;",
    },
  );
  await plugin["experimental.chat.messages.transform"](
    {},
    {
      messages: [
        {
          info: {
            id: "user-1",
            role: "user",
            sessionID: "smoke-session",
          },
          parts: [{ type: "text", text: "hello world" }],
        },
        {
          info: {
            id: "assistant-preview",
            role: "assistant",
            sessionID: "smoke-session",
          },
          parts: [
            {
              type: "tool",
              tool: "read_file",
              callID: "tool-call-1",
              state: {
                status: "completed",
                input: { path: "/tmp/example.ts" },
                output: "const value = 42;",
              },
            },
          ],
        },
      ],
    },
  );
  await plugin.event({
    event: {
      type: "message.updated",
      properties: {
        info: {
          role: "assistant",
          id: "assistant-1",
          sessionID: "smoke-session",
          parentID: "user-1",
          time: { completed: Date.now() },
          summary: false,
        },
      },
    },
  });

  const system = { system: [] };
  await plugin["experimental.chat.system.transform"](
    {
      sessionID: "smoke-session",
      model: { id: "model-smoke", limit: { context: 128000 } },
    },
    system,
  );

  const statusText = await plugin.tool.om_status.execute(
    {},
    { sessionID: "smoke-session", metadata() {} },
  );
  const status = JSON.parse(statusText);

  if (
    !system.system.some((entry) =>
      entry.includes("Before answering, call om_observe exactly once."),
    )
  ) {
    throw new Error(
      "Smoke test failed: no observe-required system block was injected.",
    );
  }
  if (status.current.requiredTool !== "om_observe") {
    throw new Error(
      `Smoke test failed: expected requiredTool=om_observe, got ${status.current.requiredTool}`,
    );
  }
  if (status.thresholds.observationThresholdTokens !== 5) {
    throw new Error(
      `Smoke test failed: expected threshold-range clamp to resolve observationThresholdTokens=5, got ${status.thresholds.observationThresholdTokens}`,
    );
  }
  if (status.current.tailRetentionUserTurns !== 3) {
    throw new Error(
      `Smoke test failed: expected tailRetentionUserTurns=3, got ${status.current.tailRetentionUserTurns}`,
    );
  }
  if (status.scope.mode !== "project") {
    throw new Error(
      `Smoke test failed: expected scope.mode=project, got ${status.scope.mode}`,
    );
  }
  if (!status.current.shareTokenBudget) {
    throw new Error(
      "Smoke test failed: expected shareTokenBudget to be enabled in status.",
    );
  }
  if (status.current.diagnostics.transformedMessageTokens <= 0) {
    throw new Error(
      "Smoke test failed: transformed-message token diagnostics were not populated.",
    );
  }
  if (status.current.diagnostics.tokenizer !== "js-tiktoken:o200k_base") {
    throw new Error(
      `Smoke test failed: unexpected tokenizer ${status.current.diagnostics.tokenizer}`,
    );
  }
  if (
    !system.system.some((entry) =>
      entry.includes("Be specific enough for the assistant to act on"),
    )
  ) {
    throw new Error(
      "Smoke test failed: observer guidelines were not injected into the maintenance prompt.",
    );
  }
  if (
    !system.system.some((entry) =>
      entry.includes("[Tool Call: read_file]") &&
      entry.includes("[Tool Result: read_file]"),
    )
  ) {
    throw new Error(
      "Smoke test failed: observe maintenance block did not include Mastra-like tool call/result formatting.",
    );
  }

  const currentTask = "Primary: Continue the smoke-test flow.";
  const suggestedResponse =
    "The assistant should continue normally after maintenance.";
  await plugin.tool.om_observe.execute(
    {
      observations:
        "Date: Jan 1, 2020\n* 🔴 (09:00) User asked for a smoke-test observation flow.\n* 🟡 (09:01) Assistant replied with a greeting.",
      currentTask,
      suggestedResponse,
      confirmObservedThrough: "user-1",
    },
    { sessionID: "smoke-session", metadata() {} },
  );

  const postObserveSystem = { system: [] };
  await plugin["experimental.chat.system.transform"](
    {
      sessionID: "smoke-session",
      model: { id: "model-smoke", limit: { context: 128000 } },
    },
    postObserveSystem,
  );

  const postStatusText = await plugin.tool.om_status.execute(
    {},
    { sessionID: "smoke-session", metadata() {} },
  );
  const postStatus = JSON.parse(postStatusText);

  if (
    !postObserveSystem.system.some((entry) => entry.includes("<observations>"))
  ) {
    throw new Error(
      "Smoke test failed: OM block was not injected after om_observe.",
    );
  }
  if (postStatus.current.lastObservedTurnAnchor !== "user-1") {
    throw new Error(
      `Smoke test failed: expected lastObservedTurnAnchor=user-1, got ${postStatus.current.lastObservedTurnAnchor}`,
    );
  }
  if (postStatus.current.requiredTool) {
    throw new Error(
      `Smoke test failed: expected no pending maintenance, got ${postStatus.current.requiredTool}`,
    );
  }
  if (
    !postObserveSystem.system.some((entry) =>
      entry.includes("The following observations block contains your memory"),
    )
  ) {
    throw new Error(
      "Smoke test failed: Mastra-like observation context prompt was not injected.",
    );
  }
  if (
    !postObserveSystem.system.some((entry) =>
      entry.includes("IMPORTANT: When responding, reference specific details"),
    )
  ) {
    throw new Error(
      "Smoke test failed: Mastra-like observation context instructions were not injected.",
    );
  }
  if (
    !postObserveSystem.system.some((entry) =>
      entry.includes("Date: Jan 1, 2020 ("),
    )
  ) {
    throw new Error(
      "Smoke test failed: relative-time annotations were not added at injection time.",
    );
  }
  if (postStatus.current.diagnostics.injectedMemoryTokens <= 0) {
    throw new Error(
      "Smoke test failed: injected memory token diagnostics were not populated.",
    );
  }

  const pruneMessages = {
    messages: [
      { info: { id: "user-1", role: "user", sessionID: "smoke-session" }, parts: [{ type: "text", text: "hello world" }] },
      { info: { id: "assistant-1", role: "assistant", sessionID: "smoke-session" }, parts: [{ type: "text", text: "reply one" }] },
      { info: { id: "user-2", role: "user", sessionID: "smoke-session" }, parts: [{ type: "text", text: "follow-up two" }] },
      { info: { id: "assistant-2", role: "assistant", sessionID: "smoke-session" }, parts: [{ type: "text", text: "reply two" }] },
      { info: { id: "user-3", role: "user", sessionID: "smoke-session" }, parts: [{ type: "text", text: "follow-up three" }] },
      { info: { id: "assistant-3", role: "assistant", sessionID: "smoke-session" }, parts: [{ type: "text", text: "reply three" }] },
      { info: { id: "user-4", role: "user", sessionID: "smoke-session" }, parts: [{ type: "text", text: "follow-up four" }] },
      { info: { id: "assistant-4", role: "assistant", sessionID: "smoke-session" }, parts: [{ type: "text", text: "reply four" }] },
      { info: { id: "user-5", role: "user", sessionID: "smoke-session" }, parts: [{ type: "text", text: "follow-up five" }] },
      { info: { id: "assistant-5", role: "assistant", sessionID: "smoke-session" }, parts: [{ type: "text", text: "reply five" }] },
    ],
  };
  await plugin["experimental.chat.messages.transform"]({}, pruneMessages);
  if (pruneMessages.messages[0]?.info.id !== "user-2") {
    throw new Error(
      `Smoke test failed: expected pruning to drop observed history through user-1, got first message ${pruneMessages.messages[0]?.info.id}`,
    );
  }

  const postPruneSystem = { system: [] };
  await plugin["experimental.chat.system.transform"](
    {
      sessionID: "smoke-session",
      model: { id: "model-smoke", limit: { context: 128000 } },
    },
    postPruneSystem,
  );
  if (
    !postPruneSystem.system.some((entry) =>
      entry.includes("the conversation history grew too long"),
    )
  ) {
    throw new Error(
      "Smoke test failed: continuation hint was not injected after pruning removed older context.",
    );
  }

  const prunedStatus = JSON.parse(
    await plugin.tool.om_status.execute(
      {},
      { sessionID: "smoke-session", metadata() {} },
    ),
  );
  if (prunedStatus.current.effectiveCutoffAnchor !== "user-1") {
    throw new Error(
      `Smoke test failed: expected effectiveCutoffAnchor=user-1, got ${prunedStatus.current.effectiveCutoffAnchor}`,
    );
  }
  if (prunedStatus.current.protectedTailAnchor !== "user-3") {
    throw new Error(
      `Smoke test failed: expected protectedTailAnchor=user-3, got ${prunedStatus.current.protectedTailAnchor}`,
    );
  }

  await plugin.tool.om_reflect.execute(
    {
      observations:
        "Date: Mar 3, 2026\n* 🔴 (09:00) User asked for a smoke-test observation flow.\n* 🟡 (09:01) Assistant replied with a greeting.",
      currentTask,
      suggestedResponse,
    },
    { sessionID: "smoke-session", metadata() {} },
  );

  const failedReflectStatus = JSON.parse(
    await plugin.tool.om_status.execute(
      {},
      { sessionID: "smoke-session", metadata() {} },
    ),
  );
  if (failedReflectStatus.stats.reflectFailures !== 1) {
    throw new Error(
      `Smoke test failed: expected reflectFailures=1 after non-reducing reflection, got ${failedReflectStatus.stats.reflectFailures}`,
    );
  }

  await plugin.tool.om_reflect.execute(
    {
      observations:
        "Date: Mar 3, 2026\n* 🔴 (09:00) User requested the OM smoke test.",
    },
    { sessionID: "smoke-session", metadata() {} },
  );

  const exportedState = JSON.parse(
    await plugin.tool.om_export.execute(
      {},
      { sessionID: "smoke-session", metadata() {} },
    ),
  );
  if (exportedState.memory.currentTask !== undefined) {
    throw new Error(
      "Smoke test failed: currentTask was not cleared when omitted from om_reflect.",
    );
  }
  if (exportedState.memory.suggestedResponse !== undefined) {
    throw new Error(
      "Smoke test failed: suggestedResponse was not cleared when omitted from om_reflect.",
    );
  }
  if (exportedState.stats.reflectFailures !== 0) {
    throw new Error(
      `Smoke test failed: expected reflectFailures to reset after successful reflection, got ${exportedState.stats.reflectFailures}`,
    );
  }

  process.stdout.write(
    JSON.stringify(
      {
        mode: "plugin",
        ok: true,
        tokenSamples,
        tools: Object.keys(plugin.tool).sort(),
        injectedSystemBlocks: postObserveSystem.system.length,
        logMessages: logs.map((entry) => entry.body.message),
      },
      null,
      2,
    ) + "\n",
  );
}

function buildTokenSamples(tokenCounter) {
  const samples = {
    prose:
      "The user asked for a concise summary of the latest auth regression and wants the fix explained clearly.",
    code: [
      "```ts",
      "export function sum(values: number[]) {",
      "  return values.reduce((total, value) => total + value, 0);",
      "}",
      "```",
    ].join("\n"),
    json: JSON.stringify(
      {
        ok: true,
        path: "/Users/example/project/src/auth.ts",
        error: "Cannot read properties of undefined (reading 'token')",
        line: 48,
      },
      null,
      2,
    ),
    stack:
      "Error: Cannot read properties of undefined (reading 'token')\n    at validateToken (/tmp/auth.ts:48:13)\n    at handleRequest (/tmp/server.ts:92:7)",
  };

  const comparisons = Object.fromEntries(
    Object.entries(samples).map(([name, text]) => [
      name,
      {
        heuristic: heuristicTokens(text),
        tokenized: tokenCounter.countString(text),
      },
    ]),
  );

  const baseMessages = [
    {
      info: { role: "user" },
      parts: [{ type: "text", text: "Please inspect src/auth.ts and explain the bug." }],
    },
    {
      info: { role: "assistant" },
      parts: [
        {
          type: "tool",
          tool: "read_file",
          callID: "tool-call-1",
          state: {
            status: "completed",
            input: { path: "/tmp/src/auth.ts" },
            output: "if (!token) throw new Error('missing token')",
          },
        },
      ],
    },
  ];
  const hiddenMetadataMessages = structuredClone(baseMessages);
  hiddenMetadataMessages[0].info.metadata = { blob: "x".repeat(6000) };
  hiddenMetadataMessages[0].parts[0].metadata = { blob: "y".repeat(6000) };

  const baseCount = tokenCounter.countMessages(baseMessages);
  const hiddenMetadataCount = tokenCounter.countMessages(hiddenMetadataMessages);
  if (baseCount !== hiddenMetadataCount) {
    throw new Error(
      "Smoke test failed: hidden metadata changed prompt-visible token counting.",
    );
  }

  const repeatA = tokenCounter.countMessages(baseMessages);
  const repeatB = tokenCounter.countMessages(baseMessages);
  if (repeatA !== repeatB) {
    throw new Error(
      "Smoke test failed: token counting was not stable across repeated runs.",
    );
  }

  const singleMessageCount = tokenCounter.countMessage(baseMessages[0]);
  const singleMessageBatch = tokenCounter.countMessages([baseMessages[0]]);
  const repeatedMessageBatch = tokenCounter.countMessages([
    baseMessages[0],
    baseMessages[0],
  ]);
  const conversationOverheadSingle = singleMessageBatch - singleMessageCount;
  const conversationOverheadRepeated =
    repeatedMessageBatch - singleMessageCount * 2;
  if (
    conversationOverheadSingle <= 0 ||
    conversationOverheadSingle !== conversationOverheadRepeated
  ) {
    throw new Error(
      "Smoke test failed: countMessage() still appears to include conversation overhead.",
    );
  }

  const mediaMessageShort = {
    info: { role: "user" },
    parts: [
      {
        type: "file",
        mime: "image/png",
        filename: "diagram.png",
        url: "https://example.com/short.png",
      },
    ],
  };
  const mediaMessageLong = {
    info: { role: "user" },
    parts: [
      {
        type: "file",
        mime: "image/png",
        filename: "diagram.png",
        url: "https://example.com/assets/" + "deep-path/".repeat(40) + "diagram.png",
      },
    ],
  };
  const mediaShortCount = tokenCounter.countMessage(mediaMessageShort);
  const mediaLongCount = tokenCounter.countMessage(mediaMessageLong);
  if (mediaLongCount <= mediaShortCount) {
    throw new Error(
      "Smoke test failed: user media counting still collapses visible file parts into a fixed placeholder.",
    );
  }

  return {
    comparisons,
    promptVisibleMetadataCheck: {
      baseCount,
      hiddenMetadataCount,
    },
    singleMessageCheck: {
      singleMessageCount,
      singleMessageBatch,
      repeatedMessageBatch,
      conversationOverheadSingle,
    },
    mediaCheck: {
      mediaShortCount,
      mediaLongCount,
    },
  };
}

function heuristicTokens(text) {
  return Math.ceil(text.length / 4);
}

function runOpencodeSmoke() {
  const bun = spawnSync("bun", ["--version"], {
    cwd: root,
    encoding: "utf8",
  });
  if (bun.status !== 0) {
    throw new Error(
      "Full OpenCode smoke test requested with --opencode, but `bun` is not installed.",
    );
  }

  const result = spawnSync(
    "bun",
    [
      "run",
      "--conditions=browser",
      "--cwd",
      path.join(root, "repos", "opencode", "packages", "opencode"),
      "src/index.ts",
      "run",
      "--format",
      "json",
      "hello world",
    ],
    {
      cwd: root,
      encoding: "utf8",
      env: {
        ...process.env,
        OPENCODE_OM_STATE_DIR: tempStateDir,
      },
    },
  );

  if (result.status !== 0) {
    process.stderr.write(result.stderr || result.stdout || "");
    throw new Error(
      `Full OpenCode smoke test failed with exit code ${result.status ?? 1}.`,
    );
  }

  process.stdout.write(
    JSON.stringify(
      {
        mode: "opencode",
        ok: true,
        stdout: (result.stdout || "").trim(),
      },
      null,
      2,
    ) + "\n",
  );
}

function assertToolKeys(plugin) {
  const expected = [
    "om_export",
    "om_forget",
    "om_observe",
    "om_reflect",
    "om_status",
  ];
  const actual = Object.keys(plugin.tool ?? {}).sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      `Smoke test failed: unexpected tool keys ${JSON.stringify(actual)}`,
    );
  }
}

function assertToolSchemas(plugin) {
  const observeArgs = Object.keys(plugin.tool.om_observe?.args ?? {}).sort();
  const reflectArgs = Object.keys(plugin.tool.om_reflect?.args ?? {}).sort();

  const expectedObserveArgs = [
    "confirmObservedThrough",
    "currentTask",
    "observations",
    "suggestedResponse",
  ];
  const expectedReflectArgs = [
    "currentTask",
    "observations",
    "suggestedResponse",
  ];

  if (JSON.stringify(observeArgs) !== JSON.stringify(expectedObserveArgs)) {
    throw new Error(
      `Smoke test failed: unexpected om_observe args ${JSON.stringify(observeArgs)}`,
    );
  }
  if (JSON.stringify(reflectArgs) !== JSON.stringify(expectedReflectArgs)) {
    throw new Error(
      `Smoke test failed: unexpected om_reflect args ${JSON.stringify(reflectArgs)}`,
    );
  }
}
