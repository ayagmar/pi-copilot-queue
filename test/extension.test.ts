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
  ) as { systemPrompt: string; message: { content: string } };

  assert.match(result.systemPrompt, /call the ask_user tool/i);
  assert.match(result.systemPrompt, /explicitly replied with stop, end, terminate, or quit/i);
  assert.doesNotMatch(result.systemPrompt, /no more interaction needed/i);
  assert.match(
    result.message.content,
    /never stop the ask_user loop unless the user explicitly replies/i
  );
});

void test("forces required tool choice for managed provider payloads when ask_user is present", () => {
  const captured = createCaptured();
  extension(createPi(captured));

  const hook = captured.eventHandlers.get("before_provider_request");
  assert.ok(hook);

  const result = hook?.(
    {
      payload: {
        tools: [
          {
            type: "function",
            function: { name: TOOL_NAME },
          },
        ],
        tool_choice: "auto",
      },
    },
    { model: { provider: "github-copilot" } }
  ) as { tool_choice: string };

  assert.equal(result.tool_choice, "required");
});

void test("does not force tool choice when ask_user is absent", () => {
  const captured = createCaptured();
  extension(createPi(captured));

  const hook = captured.eventHandlers.get("before_provider_request");
  assert.ok(hook);

  const payload = {
    tools: [
      {
        type: "function",
        function: { name: "bash" },
      },
    ],
    tool_choice: "auto",
  };

  const result = hook?.({ payload }, { model: { provider: "github-copilot" } });

  assert.deepEqual(result, payload);
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

void test("status line is cleared when model switches away from github-copilot", async () => {
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

function createCommandCtx(
  notifications?: string[],
  hasUI = false,
  provider = "github-copilot",
  statuses?: { key: string; text: string | undefined }[]
) {
  return {
    hasUI,
    model: { provider },
    ui: {
      notify: (message: string) => notifications?.push(message),
      setStatus: (key: string, text?: string) => statuses?.push({ key, text }),
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
      input: () => Promise.resolve(undefined),
      notify: (message: string) => options?.notifications?.push(message),
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
      notify: (message: string) => options.notifications?.push(message),
      setStatus: () => undefined,
    },
  };
}
