import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import extension from "../src/index.js";
import { EXTENSION_COMMAND, TOOL_NAME } from "../src/constants.js";

interface Captured {
  commandName?: string;
  commandHandler?: (args: string, ctx: unknown) => Promise<void>;
  commandCompletions?: ((prefix: string) => { value: string; label: string }[] | null) | undefined;
  toolName?: string;
  toolExecute?: (...args: unknown[]) => Promise<unknown>;
  entries: { type: "custom"; customType: string; data: unknown }[];
  eventHandlers: Map<string, (event: unknown, ctx: unknown) => unknown>;
}

function createPi(captured: Captured): ExtensionAPI {
  return {
    on: (eventName: string, handler: (event: unknown, ctx: unknown) => unknown) => {
      captured.eventHandlers.set(eventName, handler);
    },
    appendEntry: (customType: string, data: unknown) => {
      captured.entries.push({ type: "custom", customType, data });
    },
    registerCommand: (
      name: string,
      def: {
        handler: (args: string, ctx: unknown) => Promise<void>;
        getArgumentCompletions?: (prefix: string) => { value: string; label: string }[] | null;
      }
    ) => {
      captured.commandName = name;
      captured.commandHandler = def.handler;
      captured.commandCompletions = def.getArgumentCompletions;
    },
    registerTool: (def: { name: string; execute: (...args: unknown[]) => Promise<unknown> }) => {
      captured.toolName = def.name;
      captured.toolExecute = def.execute;
    },
  } as unknown as ExtensionAPI;
}

function createCaptured(): Captured {
  return { entries: [], eventHandlers: new Map() };
}

function createTempDir(): string {
  return mkdtempSync(join(tmpdir(), "pi-copilot-queue-"));
}

function writeJson(path: string, data: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(data, null, 2)}\n`);
}

void test("registers expected command and tool", () => {
  const captured = createCaptured();
  extension(createPi(captured));

  assert.equal(captured.commandName, EXTENSION_COMMAND);
  assert.equal(captured.toolName, TOOL_NAME);
});

void test("provides top-level and nested command completions", () => {
  const captured = createCaptured();
  extension(createPi(captured));

  assert.ok(captured.commandCompletions);

  const topLevel = captured.commandCompletions?.("se") ?? [];
  assert.ok(topLevel.some((item) => item.value === "settings"));
  assert.ok(topLevel.some((item) => item.label.includes("settings")));

  const nested = captured.commandCompletions?.("providers global o") ?? [];
  assert.ok(nested.some((item) => item.value === "providers global off"));
});

void test("injects ask_user policy into the system prompt without a hidden reminder", () => {
  const captured = createCaptured();
  extension(createPi(captured));

  const hook = captured.eventHandlers.get("before_agent_start");
  assert.ok(hook);

  const result = hook?.(
    { systemPrompt: "base prompt" },
    { model: { provider: "github-copilot" } }
  ) as { systemPrompt: string; message?: { content: string } };

  assert.match(result.systemPrompt, /call the ask_user tool/i);
  assert.match(result.systemPrompt, /explicitly replied with stop, end, terminate, or quit/i);
  assert.doesNotMatch(result.systemPrompt, /no more interaction needed/i);
  assert.equal(result.message, undefined);
});

void test("does not register a before_provider_request hook", () => {
  const captured = createCaptured();
  extension(createPi(captured));

  const hook = captured.eventHandlers.get("before_provider_request");

  assert.equal(hook, undefined);
});

void test("interactive input during active run is queued instead of sent", async () => {
  const captured = createCaptured();
  extension(createPi(captured));

  const inputHook = captured.eventHandlers.get("input");
  assert.ok(inputHook);
  assert.ok(captured.toolExecute);

  const inputResult = inputHook?.(
    { text: "please continue with tests", source: "interactive" },
    createInputCtx({ idle: false })
  ) as { action: string };

  assert.equal(inputResult.action, "handled");

  const toolResult = (await captured.toolExecute?.(
    "call-1",
    {},
    undefined,
    undefined,
    createToolCtx()
  )) as { content: { type: string; text: string }[]; details: { source: string } };

  assert.equal(toolResult.content[0]?.text, "please continue with tests");
  assert.equal(toolResult.details.source, "queue");
});

void test("capture off keeps busy interactive input in normal steering path", async () => {
  const captured = createCaptured();
  extension(createPi(captured));

  const inputHook = captured.eventHandlers.get("input");
  assert.ok(inputHook);
  assert.ok(captured.commandHandler);
  assert.ok(captured.toolExecute);

  await captured.commandHandler?.("capture off", createCommandCtx());

  const inputResult = inputHook?.(
    { text: "do not queue this", source: "interactive" },
    createInputCtx({ idle: false })
  ) as { action: string };

  assert.equal(inputResult.action, "continue");

  const toolResult = (await captured.toolExecute?.(
    "call-1",
    {},
    undefined,
    undefined,
    createToolCtx()
  )) as { content: { type: string; text: string }[]; details: { source: string } };

  assert.equal(toolResult.content[0]?.text, "continue");
  assert.equal(toolResult.details.source, "fallback");
});

void test("copilot waits when empty and resumes when new queue item is added", async () => {
  const captured = createCaptured();
  extension(createPi(captured));

  assert.ok(captured.commandHandler);
  assert.ok(captured.toolExecute);

  const waitingResultPromise = captured.toolExecute?.(
    "call-1",
    { prompt: "Need your next instruction" },
    undefined,
    undefined,
    createToolCtx({ hasUI: true })
  ) as Promise<{ content: { type: string; text: string }[]; details: { source: string } }>;

  await Promise.resolve();
  await captured.commandHandler?.("add continue with final polish", createCommandCtx());

  const waitingResult = await waitingResultPromise;
  assert.equal(waitingResult.content[0]?.text, "continue with final polish");
  assert.equal(waitingResult.details.source, "queue-live");
});

void test("session switch clears stale waiting ask_user state", async () => {
  const captured = createCaptured();
  extension(createPi(captured));

  const sessionSwitchHook = captured.eventHandlers.get("session_switch");
  const notifications: string[] = [];
  const abortController = new AbortController();

  assert.ok(captured.commandHandler);
  assert.ok(captured.toolExecute);
  assert.ok(sessionSwitchHook);

  const waitingResultPromise = captured.toolExecute?.(
    "call-1",
    { prompt: "Need your next instruction" },
    abortController.signal,
    undefined,
    createToolCtx({ hasUI: true })
  ) as Promise<{ content: { type: string; text: string }[]; details: { source: string } }>;

  await Promise.resolve();
  sessionSwitchHook?.({}, createSessionCtx());
  await captured.commandHandler?.(
    "add continue after switch",
    createCommandCtx(notifications, true)
  );

  const queuedResult = (await captured.toolExecute?.(
    "call-2",
    {},
    undefined,
    undefined,
    createToolCtx()
  )) as { content: { type: string; text: string }[]; details: { source: string } };

  abortController.abort();
  await waitingResultPromise;

  assert.ok(notifications.some((line) => line.includes("Queued (#1): continue after switch")));
  assert.equal(queuedResult.content[0]?.text, "continue after switch");
  assert.equal(queuedResult.details.source, "queue");
});

void test("done command releases waiting ask_user with stop", async () => {
  const captured = createCaptured();
  extension(createPi(captured));

  assert.ok(captured.commandHandler);
  assert.ok(captured.toolExecute);

  const waitingResultPromise = captured.toolExecute?.(
    "call-1",
    { prompt: "Need your next instruction" },
    undefined,
    undefined,
    createToolCtx({ hasUI: true })
  ) as Promise<{ content: { type: string; text: string }[]; details: { source: string } }>;

  await Promise.resolve();
  await captured.commandHandler?.("done", createCommandCtx());

  const waitingResult = await waitingResultPromise;
  assert.equal(waitingResult.content[0]?.text, "stop");
  assert.equal(waitingResult.details.source, "stop");
});

void test("stop command makes the next ask_user return stop", async () => {
  const captured = createCaptured();
  extension(createPi(captured));

  assert.ok(captured.commandHandler);
  assert.ok(captured.toolExecute);

  await captured.commandHandler?.("stop", createCommandCtx());

  const result = (await captured.toolExecute?.(
    "call-1",
    {},
    undefined,
    undefined,
    createToolCtx()
  )) as { content: { type: string; text: string }[]; details: { source: string } };

  assert.equal(result.content[0]?.text, "stop");
  assert.equal(result.details.source, "stop");
});

void test("new queued input clears a pending stop request", async () => {
  const captured = createCaptured();
  extension(createPi(captured));

  assert.ok(captured.commandHandler);
  assert.ok(captured.toolExecute);

  await captured.commandHandler?.("stop", createCommandCtx());
  await captured.commandHandler?.("add continue instead", createCommandCtx());

  const result = (await captured.toolExecute?.(
    "call-1",
    {},
    undefined,
    undefined,
    createToolCtx()
  )) as { content: { type: string; text: string }[]; details: { source: string } };

  assert.equal(result.content[0]?.text, "continue instead");
  assert.equal(result.details.source, "queue");
});

void test("wait timeout returns fallback when no queued input arrives", async () => {
  const captured = createCaptured();
  extension(createPi(captured));

  assert.ok(captured.commandHandler);
  assert.ok(captured.toolExecute);

  await captured.commandHandler?.("wait-timeout 1", createCommandCtx());
  const waitingResultPromise = captured.toolExecute?.(
    "call-1",
    { prompt: "Need your next instruction" },
    undefined,
    undefined,
    createToolCtx({ hasUI: true })
  ) as Promise<{ content: { type: string; text: string }[]; details: { source: string } }>;

  const waitingResult = await waitingResultPromise;
  assert.equal(waitingResult.content[0]?.text, "continue");
  assert.equal(waitingResult.details.source, "fallback");
});

void test("queued input after timeout is not swallowed by stale waiting state", async () => {
  const captured = createCaptured();
  extension(createPi(captured));

  assert.ok(captured.commandHandler);
  assert.ok(captured.toolExecute);

  await captured.commandHandler?.("wait-timeout 1", createCommandCtx());

  const waitingResult = (await captured.toolExecute?.(
    "call-1",
    { prompt: "Need your next instruction" },
    undefined,
    undefined,
    createToolCtx({ hasUI: true })
  )) as { content: { type: string; text: string }[]; details: { source: string } };

  assert.equal(waitingResult.details.source, "fallback");

  await captured.commandHandler?.("add continue after timeout", createCommandCtx());

  const queuedResult = (await captured.toolExecute?.(
    "call-2",
    {},
    undefined,
    undefined,
    createToolCtx()
  )) as { content: { type: string; text: string }[]; details: { source: string } };

  assert.equal(queuedResult.content[0]?.text, "continue after timeout");
  assert.equal(queuedResult.details.source, "queue");
});

void test("session compact persists current queue state", async () => {
  const captured = createCaptured();
  extension(createPi(captured));

  assert.ok(captured.commandHandler);
  const compactHook = captured.eventHandlers.get("session_compact");
  assert.ok(compactHook);

  await captured.commandHandler?.("add preserve me", createCommandCtx());

  const beforeCount = captured.entries.length;
  compactHook?.({}, createToolCtx());

  const lastEntry = captured.entries[captured.entries.length - 1];
  assert.ok(lastEntry);
  assert.equal(captured.entries.length, beforeCount + 1);
  assert.equal(lastEntry?.customType, "copilot-queue:state");
  assert.deepEqual((lastEntry?.data as { queue?: string[] }).queue, ["preserve me"]);
});

void test("session status and reset commands work", async () => {
  const captured = createCaptured();
  extension(createPi(captured));

  const notifications: string[] = [];
  const toolCallHook = captured.eventHandlers.get("tool_call");

  assert.ok(captured.commandHandler);
  assert.ok(toolCallHook);

  toolCallHook?.({ toolName: TOOL_NAME }, createToolCtx());
  await captured.commandHandler?.("session status", createCommandCtx(notifications, true));
  assert.ok(notifications.some((line) => line.includes("Session status:")));
  assert.ok(notifications.some((line) => line.includes("Tool calls: 1")));

  await captured.commandHandler?.("session reset", createCommandCtx(notifications, true));
  const lastState = captured.entries[captured.entries.length - 1]?.data as {
    toolCallCount: number;
    completedRunCount: number;
    missedAskUserRunCount: number;
  };
  assert.equal(lastState.toolCallCount, 0);
  assert.equal(lastState.completedRunCount, 0);
  assert.equal(lastState.missedAskUserRunCount, 0);
});

void test("tracks missed ask_user runs when copilot replies directly", async () => {
  const captured = createCaptured();
  extension(createPi(captured));

  const notifications: string[] = [];
  const beforeAgentStartHook = captured.eventHandlers.get("before_agent_start");
  const agentEndHook = captured.eventHandlers.get("agent_end");

  assert.ok(captured.commandHandler);
  assert.ok(beforeAgentStartHook);
  assert.ok(agentEndHook);

  beforeAgentStartHook?.({ systemPrompt: "base prompt" }, createToolCtx({ hasUI: true }));
  agentEndHook?.(
    {
      messages: [
        {
          role: "assistant",
          content: [{ type: "text", text: "Here is a direct answer instead of ask_user." }],
        },
      ],
    },
    createToolCtx({ hasUI: true, notifications })
  );

  await captured.commandHandler?.("session status", createCommandCtx(notifications, true));

  assert.ok(notifications.some((line) => line.includes("Direct replies without ask_user: 1")));
  assert.ok(
    notifications.some((line) => line.includes("Last missed direct reply: Here is a direct answer"))
  );
});

void test("tracks successful runs that used ask_user", async () => {
  const captured = createCaptured();
  extension(createPi(captured));

  const notifications: string[] = [];
  const beforeAgentStartHook = captured.eventHandlers.get("before_agent_start");
  const toolCallHook = captured.eventHandlers.get("tool_call");
  const agentEndHook = captured.eventHandlers.get("agent_end");

  assert.ok(captured.commandHandler);
  assert.ok(beforeAgentStartHook);
  assert.ok(toolCallHook);
  assert.ok(agentEndHook);

  beforeAgentStartHook?.({ systemPrompt: "base prompt" }, createToolCtx());
  toolCallHook?.({ toolName: TOOL_NAME }, createToolCtx());
  agentEndHook?.(
    {
      messages: [
        {
          role: "assistant",
          content: [{ type: "text", text: "Applied the feedback and kept going." }],
        },
      ],
    },
    createToolCtx()
  );

  await captured.commandHandler?.("session status", createCommandCtx(notifications, true));

  assert.ok(notifications.some((line) => line.includes("Completed managed-provider runs: 1")));
  assert.ok(notifications.some((line) => line.includes("Runs with ask_user: 1")));
  assert.ok(notifications.some((line) => line.includes("Direct replies without ask_user: 0")));
});

void test("tool-call warning fires at configurable threshold", async () => {
  const captured = createCaptured();
  extension(createPi(captured));

  const notifications: string[] = [];
  const toolCallHook = captured.eventHandlers.get("tool_call");

  assert.ok(captured.commandHandler);
  assert.ok(toolCallHook);

  await captured.commandHandler?.("session threshold 999 2", createCommandCtx(notifications));
  toolCallHook?.({ toolName: TOOL_NAME }, createToolCtx({ hasUI: true, notifications }));
  toolCallHook?.({ toolName: TOOL_NAME }, createToolCtx({ hasUI: true, notifications }));

  assert.ok(
    notifications.some(
      (line) => line.includes("Session hygiene warning") && line.includes("2 tool calls reached")
    )
  );
});

void test("session tool-call counter includes non-ask_user tools", async () => {
  const captured = createCaptured();
  extension(createPi(captured));

  const notifications: string[] = [];
  const toolCallHook = captured.eventHandlers.get("tool_call");

  assert.ok(captured.commandHandler);
  assert.ok(toolCallHook);

  toolCallHook?.({ toolName: "bash" }, createToolCtx());
  await captured.commandHandler?.("session status", createCommandCtx(notifications, true));

  assert.ok(notifications.some((line) => line.includes("Tool calls: 1")));
});

void test("does not inject ask_user policy for non-copilot provider", () => {
  const captured = createCaptured();
  extension(createPi(captured));

  const hook = captured.eventHandlers.get("before_agent_start");
  assert.ok(hook);

  const result = hook?.({ systemPrompt: "base prompt" }, { model: { provider: "anthropic" } });

  assert.equal(result, undefined);
});

void test("queued message is returned before fallback", async () => {
  const captured = createCaptured();
  extension(createPi(captured));

  assert.ok(captured.commandHandler);
  assert.ok(captured.toolExecute);

  await captured.commandHandler?.("add first queued reply", createCommandCtx());

  const result = (await captured.toolExecute?.(
    "call-1",
    {},
    undefined,
    undefined,
    createToolCtx()
  )) as { content: { type: string; text: string }[]; details: { source: string } };

  assert.equal(result.content[0]?.text, "first queued reply");
  assert.equal(result.details.source, "queue");
});

void test("autopilot cycles prompts when enabled", async () => {
  const captured = createCaptured();
  extension(createPi(captured));

  assert.ok(captured.commandHandler);
  assert.ok(captured.toolExecute);

  await captured.commandHandler?.("autopilot add first auto", createCommandCtx());
  await captured.commandHandler?.("autopilot add second auto", createCommandCtx());
  await captured.commandHandler?.("autopilot on", createCommandCtx());

  const result1 = (await captured.toolExecute?.(
    "call-1",
    {},
    undefined,
    undefined,
    createToolCtx()
  )) as { content: { type: string; text: string }[]; details: { source: string } };

  const result2 = (await captured.toolExecute?.(
    "call-2",
    {},
    undefined,
    undefined,
    createToolCtx()
  )) as { content: { type: string; text: string }[]; details: { source: string } };

  const result3 = (await captured.toolExecute?.(
    "call-3",
    {},
    undefined,
    undefined,
    createToolCtx()
  )) as { content: { type: string; text: string }[]; details: { source: string } };

  assert.equal(result1.content[0]?.text, "first auto");
  assert.equal(result2.content[0]?.text, "second auto");
  assert.equal(result3.content[0]?.text, "first auto");
  assert.equal(result1.details.source, "autopilot");
});

void test("queue remains higher priority than autopilot", async () => {
  const captured = createCaptured();
  extension(createPi(captured));

  assert.ok(captured.commandHandler);
  assert.ok(captured.toolExecute);

  await captured.commandHandler?.("autopilot add auto reply", createCommandCtx());
  await captured.commandHandler?.("autopilot on", createCommandCtx());
  await captured.commandHandler?.("add queued reply", createCommandCtx());

  const queuedResult = (await captured.toolExecute?.(
    "call-1",
    {},
    undefined,
    undefined,
    createToolCtx()
  )) as { content: { type: string; text: string }[]; details: { source: string } };

  const autopilotResult = (await captured.toolExecute?.(
    "call-2",
    {},
    undefined,
    undefined,
    createToolCtx()
  )) as { content: { type: string; text: string }[]; details: { source: string } };

  assert.equal(queuedResult.content[0]?.text, "queued reply");
  assert.equal(queuedResult.details.source, "queue");
  assert.equal(autopilotResult.content[0]?.text, "auto reply");
  assert.equal(autopilotResult.details.source, "autopilot");
});

void test("non-copilot providers bypass queue and autopilot", async () => {
  const captured = createCaptured();
  extension(createPi(captured));

  assert.ok(captured.commandHandler);
  assert.ok(captured.toolExecute);

  await captured.commandHandler?.("add queued reply", createCommandCtx());
  await captured.commandHandler?.("autopilot add auto reply", createCommandCtx());
  await captured.commandHandler?.("autopilot on", createCommandCtx());

  const result = (await captured.toolExecute?.(
    "call-1",
    {},
    undefined,
    undefined,
    createToolCtx({ provider: "anthropic" })
  )) as { content: { type: string; text: string }[]; details: { source: string } };

  assert.equal(result.content[0]?.text, "continue");
  assert.equal(result.details.source, "fallback");
});

void test("status line uses theme styling when UI theme is available", async () => {
  const previousCwd = process.cwd();
  const cwd = createTempDir();

  try {
    process.chdir(cwd);

    const captured = createCaptured();
    extension(createPi(captured));

    const statuses: { key: string; text: string | undefined }[] = [];

    assert.ok(captured.commandHandler);

    await captured.commandHandler?.(
      "add queued reply",
      createCommandCtx(undefined, true, "github-copilot", statuses)
    );

    const lastStatus = statuses[statuses.length - 1];
    assert.equal(lastStatus?.key, EXTENSION_COMMAND);
    assert.match(lastStatus?.text ?? "", /<accent>\*\*Copilot Queue\*\*<\/accent>/);
    assert.match(lastStatus?.text ?? "", /<dim> • <\/dim>/);
  } finally {
    process.chdir(previousCwd);
    rmSync(cwd, { recursive: true, force: true });
  }
});

void test("status line is cleared when model switches away from github-copilot", async () => {
  const previousCwd = process.cwd();
  const cwd = createTempDir();

  try {
    process.chdir(cwd);

    const captured = createCaptured();
    extension(createPi(captured));

    const statuses: { key: string; text: string | undefined }[] = [];
    const modelSelectHook = captured.eventHandlers.get("model_select");

    assert.ok(captured.commandHandler);
    assert.ok(modelSelectHook);

    await captured.commandHandler?.(
      "add queued reply",
      createCommandCtx(undefined, true, "github-copilot", statuses)
    );
    assert.match(statuses[statuses.length - 1]?.text ?? "", /Copilot Queue/);

    modelSelectHook?.({}, createToolCtx({ provider: "anthropic", hasUI: true, statuses }));

    const lastStatus = statuses[statuses.length - 1];
    assert.equal(lastStatus?.key, EXTENSION_COMMAND);
    assert.equal(lastStatus?.text, undefined);
  } finally {
    process.chdir(previousCwd);
    rmSync(cwd, { recursive: true, force: true });
  }
});

void test("status line stays hidden when showStatusLine is false", async () => {
  const previousCwd = process.cwd();
  const previousHome = process.env.HOME;
  const cwd = createTempDir();
  const homeDir = createTempDir();

  try {
    writeJson(join(homeDir, ".pi", "agent", "settings.json"), {
      copilotQueue: {
        providers: ["github-copilot"],
        showStatusLine: false,
      },
    });
    process.chdir(cwd);
    process.env.HOME = homeDir;

    const captured = createCaptured();
    extension(createPi(captured));

    const statuses: { key: string; text: string | undefined }[] = [];

    assert.ok(captured.commandHandler);

    await captured.commandHandler?.(
      "add queued reply",
      createCommandCtx(undefined, true, "github-copilot", statuses)
    );

    const lastStatus = statuses[statuses.length - 1];
    assert.equal(lastStatus?.key, EXTENSION_COMMAND);
    assert.equal(lastStatus?.text, undefined);
  } finally {
    process.chdir(previousCwd);
    if (previousHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = previousHome;
    }
    rmSync(cwd, { recursive: true, force: true });
    rmSync(homeDir, { recursive: true, force: true });
  }
});

void test("uses fallback when queue is empty and no UI", async () => {
  const captured = createCaptured();
  extension(createPi(captured));

  assert.ok(captured.toolExecute);

  const result = (await captured.toolExecute?.(
    "call-1",
    {},
    undefined,
    undefined,
    createToolCtx()
  )) as { content: { type: string; text: string }[]; details: { source: string } };

  assert.equal(result.content[0]?.text, "continue");
  assert.equal(result.details.source, "fallback");
});

void test("settings command reports a summary without UI", async () => {
  const previousCwd = process.cwd();
  const cwd = createTempDir();
  const logs: string[] = [];
  const originalLog = console.log;
  console.log = (message?: unknown) => {
    if (typeof message === "string") {
      logs.push(message);
      return;
    }

    logs.push("");
  };

  try {
    process.chdir(cwd);

    const captured = createCaptured();
    extension(createPi(captured));

    assert.ok(captured.commandHandler);

    await captured.commandHandler?.("settings", createCommandCtx(undefined, false));

    assert.ok(logs.some((line) => line.includes("Copilot Queue settings:")));
    assert.ok(logs.some((line) => line.includes("Status line: on")));
    assert.ok(logs.some((line) => line.includes("Warning thresholds: 120 minutes, 50 tool calls")));
  } finally {
    console.log = originalLog;
    process.chdir(previousCwd);
    rmSync(cwd, { recursive: true, force: true });
  }
});

void test("settings UI can update global providers", async () => {
  const previousCwd = process.cwd();
  const previousHome = process.env.HOME;
  const cwd = createTempDir();
  const homeDir = createTempDir();

  try {
    process.chdir(cwd);
    process.env.HOME = homeDir;

    const captured = createCaptured();
    extension(createPi(captured));

    assert.ok(captured.commandHandler);

    await captured.commandHandler?.(
      "settings",
      createCommandCtx(undefined, true, "github-copilot", undefined, {
        select: ["Managed providers: github-copilot", "Set global providers", "Close"],
        input: ["openai anthropic"],
      })
    );

    const settingsPath = join(homeDir, ".pi", "agent", "settings.json");
    const written = JSON.parse(readFileSync(settingsPath, "utf8")) as {
      copilotQueue?: { providers?: string[] };
    };
    assert.deepEqual(written.copilotQueue?.providers, ["openai", "anthropic"]);
  } finally {
    process.chdir(previousCwd);
    if (previousHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = previousHome;
    }
    rmSync(cwd, { recursive: true, force: true });
    rmSync(homeDir, { recursive: true, force: true });
  }
});

void test("settings UI can update warning thresholds", async () => {
  const captured = createCaptured();
  extension(createPi(captured));

  const notifications: string[] = [];

  assert.ok(captured.commandHandler);

  await captured.commandHandler?.(
    "settings",
    createCommandCtx(notifications, true, "github-copilot", undefined, {
      select: ["Warning thresholds: 120m / 50 tools", "Close"],
      input: ["180", "75"],
    })
  );

  const lastState = captured.entries[captured.entries.length - 1]?.data as {
    warningMinutes: number;
    warningToolCalls: number;
  };
  assert.equal(lastState.warningMinutes, 180);
  assert.equal(lastState.warningToolCalls, 75);
});

void test("settings UI can update custom wait timeout after invalid input", async () => {
  const captured = createCaptured();
  extension(createPi(captured));

  const notifications: string[] = [];

  assert.ok(captured.commandHandler);

  await captured.commandHandler?.(
    "settings",
    createCommandCtx(notifications, true, "github-copilot", undefined, {
      select: ["Empty-queue wait timeout: off", "Custom value...", "Close"],
      input: ["abc", "45"],
    })
  );

  const lastState = captured.entries[captured.entries.length - 1]?.data as {
    waitTimeoutSeconds: number;
  };
  assert.equal(lastState.waitTimeoutSeconds, 45);
  assert.ok(notifications.some((line) => line.includes("Enter a whole number 0 or greater.")));
});

void test("providers command updates global settings and managed provider scope", async () => {
  const previousCwd = process.cwd();
  const previousHome = process.env.HOME;
  const cwd = createTempDir();
  const homeDir = createTempDir();

  try {
    writeJson(join(homeDir, ".pi", "agent", "settings.json"), {
      copilotQueue: {
        providers: ["github-copilot"],
      },
    });
    process.chdir(cwd);
    process.env.HOME = homeDir;

    const captured = createCaptured();
    extension(createPi(captured));

    const beforeAgentStartHook = captured.eventHandlers.get("before_agent_start");
    assert.ok(captured.commandHandler);
    assert.ok(beforeAgentStartHook);

    const beforeUpdate = beforeAgentStartHook?.(
      { systemPrompt: "base prompt" },
      createToolCtx({ provider: "openai" })
    );
    assert.equal(beforeUpdate, undefined);

    await captured.commandHandler?.("providers openai anthropic", createCommandCtx());

    const settingsPath = join(homeDir, ".pi", "agent", "settings.json");
    const written = JSON.parse(readFileSync(settingsPath, "utf8")) as {
      copilotQueue?: { providers?: string[] };
    };
    assert.deepEqual(written.copilotQueue?.providers, ["openai", "anthropic"]);

    const afterUpdate = beforeAgentStartHook?.(
      { systemPrompt: "base prompt" },
      createToolCtx({ provider: "openai" })
    ) as { systemPrompt: string } | undefined;
    assert.ok(afterUpdate);
    assert.match(afterUpdate.systemPrompt, /call the ask_user tool/i);
  } finally {
    process.chdir(previousCwd);
    if (previousHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = previousHome;
    }
    rmSync(cwd, { recursive: true, force: true });
    rmSync(homeDir, { recursive: true, force: true });
  }
});

void test("providers command still accepts the global prefix", async () => {
  const previousCwd = process.cwd();
  const previousHome = process.env.HOME;
  const cwd = createTempDir();
  const homeDir = createTempDir();

  try {
    process.chdir(cwd);
    process.env.HOME = homeDir;

    const captured = createCaptured();
    extension(createPi(captured));

    const beforeAgentStartHook = captured.eventHandlers.get("before_agent_start");
    assert.ok(captured.commandHandler);
    assert.ok(beforeAgentStartHook);

    const beforeUpdate = beforeAgentStartHook?.(
      { systemPrompt: "base prompt" },
      createToolCtx({ provider: "openai" })
    );
    assert.equal(beforeUpdate, undefined);

    await captured.commandHandler?.("providers global openai anthropic", createCommandCtx());

    const settingsPath = join(homeDir, ".pi", "agent", "settings.json");
    const written = JSON.parse(readFileSync(settingsPath, "utf8")) as {
      copilotQueue?: { providers?: string[] };
    };
    assert.deepEqual(written.copilotQueue?.providers, ["openai", "anthropic"]);

    const afterUpdate = beforeAgentStartHook?.(
      { systemPrompt: "base prompt" },
      createToolCtx({ provider: "openai" })
    ) as { systemPrompt: string } | undefined;
    assert.ok(afterUpdate);
    assert.match(afterUpdate.systemPrompt, /call the ask_user tool/i);
  } finally {
    process.chdir(previousCwd);
    if (previousHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = previousHome;
    }
    rmSync(cwd, { recursive: true, force: true });
    rmSync(homeDir, { recursive: true, force: true });
  }
});

void test("providers command rejects the removed project prefix", async () => {
  const captured = createCaptured();
  extension(createPi(captured));

  const notifications: string[] = [];

  assert.ok(captured.commandHandler);

  await captured.commandHandler?.(
    "providers project openai",
    createCommandCtx(notifications, true)
  );

  assert.ok(
    notifications.some((line) => line.includes("Project-scoped providers are no longer supported"))
  );
});

function createTheme() {
  return {
    fg: (color: string, text: string) => `<${color}>${text}</${color}>`,
    bold: (text: string) => `**${text}**`,
  };
}

function createCommandCtx(
  notifications?: string[],
  hasUI = false,
  provider = "github-copilot",
  statuses?: { key: string; text: string | undefined }[],
  responses?: {
    select?: string[];
    input?: string[];
    confirm?: boolean[];
  }
) {
  return {
    hasUI,
    model: { provider },
    ui: {
      theme: createTheme(),
      notify: (message: string) => notifications?.push(message),
      setStatus: (key: string, text?: string) => statuses?.push({ key, text }),
      select: () => Promise.resolve(responses?.select?.shift()),
      input: () => Promise.resolve(responses?.input?.shift()),
      confirm: () => Promise.resolve(responses?.confirm?.shift() ?? false),
    },
  };
}

function createToolCtx(options?: {
  provider?: string;
  hasUI?: boolean;
  notifications?: string[];
  statuses?: { key: string; text: string | undefined }[];
}) {
  return {
    hasUI: options?.hasUI ?? false,
    model: { provider: options?.provider ?? "github-copilot" },
    ui: {
      theme: createTheme(),
      input: () => Promise.resolve(undefined),
      notify: (message: string) => options?.notifications?.push(message),
      setStatus: (key: string, text?: string) => options?.statuses?.push({ key, text }),
    },
  };
}

function createSessionCtx(options?: {
  provider?: string;
  hasUI?: boolean;
  statuses?: { key: string; text: string | undefined }[];
}) {
  return {
    hasUI: options?.hasUI ?? true,
    model: { provider: options?.provider ?? "github-copilot" },
    sessionManager: { getBranch: () => [] },
    ui: {
      theme: createTheme(),
      notify: () => undefined,
      setStatus: (key: string, text?: string) => options?.statuses?.push({ key, text }),
    },
  };
}

function createInputCtx(options: { idle: boolean; provider?: string; notifications?: string[] }) {
  return {
    hasUI: false,
    model: { provider: options.provider ?? "github-copilot" },
    isIdle: () => options.idle,
    ui: {
      theme: createTheme(),
      notify: (message: string) => options.notifications?.push(message),
      setStatus: () => undefined,
    },
  };
}
