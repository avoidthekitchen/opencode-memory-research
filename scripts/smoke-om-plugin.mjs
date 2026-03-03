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
  process.env.OPENCODE_OM_OBSERVE_TOKENS = "1";

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
  const { ObservationalMemoryPlugin } = pluginModule;

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

  await plugin["chat.message"](
    { sessionID: "smoke-session", messageID: "user-1" },
    {
      message: { id: "user-1" },
      parts: [{ type: "text", text: "hello world" }],
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

  await plugin.tool.om_observe.execute(
    {
      observations:
        "Date: Mar 3, 2026\n* 🔴 (09:00) User asked for a smoke-test observation flow.\n* 🟡 (09:01) Assistant replied with a greeting.",
      currentTask: "Primary: Continue the smoke-test flow.",
      suggestedResponse:
        "The assistant should continue normally after maintenance.",
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

  process.stdout.write(
    JSON.stringify(
      {
        mode: "plugin",
        ok: true,
        tools: Object.keys(plugin.tool).sort(),
        injectedSystemBlocks: postObserveSystem.system.length,
        logMessages: logs.map((entry) => entry.body.message),
      },
      null,
      2,
    ) + "\n",
  );
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
      "--cwd",
      path.join(root, "repos", "opencode"),
      "--conditions=browser",
      "packages/opencode/src/index.ts",
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
