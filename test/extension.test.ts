import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import extension from "../src/index.js";
import { EXTENSION_COMMAND, TOOL_NAME } from "../src/constants.js";

interface Captured {
  commandName?: string;
  commandHandler?: (args: string, ctx: unknown) => Promise<void>;
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
      def: { handler: (args: string, ctx: unknown) => Promise<void> }
    ) => {
      captured.commandName = name;
      captured.commandHandler = def.handler;
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

void test("registers expected command and tool", () => {
  const captured = createCaptured();
  extension(createPi(captured));

  assert.equal(captured.commandName, EXTENSION_COMMAND);
  assert.equal(captured.toolName, TOOL_NAME);
});

void test("injects ask_user policy for github-copilot", () => {
  const captured = createCaptured();
  extension(createPi(captured));

  const hook = captured.eventHandlers.get("before_agent_start");
  assert.ok(hook);

  const result = hook?.(
    { systemPrompt: "base prompt" },
    { model: { provider: "github-copilot" } }
  ) as { systemPrompt: string };

  assert.match(result.systemPrompt, /call the ask_user tool/i);
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

void test("done command releases waiting ask_user", async () => {
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
  assert.equal(waitingResult.content[0]?.text, "done");
  assert.equal(waitingResult.details.source, "done");
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

void test("session compact schedules one-time ask_user policy reinforcement", () => {
  const captured = createCaptured();
  extension(createPi(captured));

  const compactHook = captured.eventHandlers.get("session_compact");
  const contextHook = captured.eventHandlers.get("context");

  assert.ok(compactHook);
  assert.ok(contextHook);

  compactHook?.({}, createToolCtx());

  const first = contextHook?.({ messages: [] }, createToolCtx()) as
    | { messages?: { role?: string; customType?: string; content?: string }[] }
    | undefined;
  assert.ok(first?.messages);
  assert.equal(first?.messages?.length, 1);
  assert.equal(first?.messages?.[0]?.role, "custom");
  assert.equal(first?.messages?.[0]?.customType, "copilot-queue:policy-reinforcement");
  assert.match(first?.messages?.[0]?.content ?? "", /call the ask_user tool/i);

  const second = contextHook?.({ messages: [] }, createToolCtx());
  assert.equal(second, undefined);
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
  };
  assert.equal(lastState.toolCallCount, 0);
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

void test("session tool-call counter ignores non-ask_user tools", async () => {
  const captured = createCaptured();
  extension(createPi(captured));

  const notifications: string[] = [];
  const toolCallHook = captured.eventHandlers.get("tool_call");

  assert.ok(captured.commandHandler);
  assert.ok(toolCallHook);

  toolCallHook?.({ toolName: "bash" }, createToolCtx());
  await captured.commandHandler?.("session status", createCommandCtx(notifications, true));

  assert.ok(notifications.some((line) => line.includes("Tool calls: 0")));
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

function createCommandCtx(notifications?: string[], hasUI = false) {
  return {
    hasUI,
    ui: {
      notify: (message: string) => notifications?.push(message),
      setStatus: () => undefined,
    },
  };
}

function createToolCtx(options?: { provider?: string; hasUI?: boolean; notifications?: string[] }) {
  return {
    hasUI: options?.hasUI ?? false,
    model: { provider: options?.provider ?? "github-copilot" },
    ui: {
      input: () => Promise.resolve(undefined),
      notify: (message: string) => options?.notifications?.push(message),
      setStatus: () => undefined,
    },
  };
}

function createInputCtx(options: { idle: boolean; provider?: string; notifications?: string[] }) {
  return {
    hasUI: false,
    model: { provider: options.provider ?? "github-copilot" },
    isIdle: () => options.idle,
    ui: {
      notify: (message: string) => options.notifications?.push(message),
      setStatus: () => undefined,
    },
  };
}
