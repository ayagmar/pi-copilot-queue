import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";
import { buildHelpText, parseCommand } from "./commands.js";
import {
  resolveConfiguredProviders,
  writeGlobalConfiguredProviders,
  writeProjectConfiguredProviders,
} from "./config.js";
import {
  COPILOT_ASK_USER_POLICY,
  COPILOT_ASK_USER_REMINDER_MESSAGE,
  DEFAULT_FALLBACK_RESPONSE,
  DEFAULT_WAIT_TIMEOUT_SECONDS,
  DEFAULT_WARNING_MINUTES,
  DEFAULT_WARNING_TOOL_CALLS,
  EXTENSION_COMMAND,
  EXTENSION_NAME,
  STATE_ENTRY_TYPE,
  TOOL_NAME,
} from "./constants.js";
import { notifyTerminal } from "./notify.js";
import type { QueueState } from "./types.js";

const STOP_RESPONSE = "stop";
let configuredProviders = resolveConfiguredProviders(process.cwd());

export default function copilotQueueExtension(pi: ExtensionAPI) {
  refreshConfiguredProviders();

  let state: QueueState = initialState();
  let pendingAskUserResolve: ((text: string) => void) | undefined;
  let currentRunStarted = false;
  let currentRunAskUserCallCount = 0;

  function hasPendingAskUser(): boolean {
    return Boolean(pendingAskUserResolve);
  }

  function isManagedProvider(ctx: Pick<ExtensionContext, "model">): boolean {
    const provider = ctx.model?.provider;
    if (!provider) {
      return false;
    }

    return configuredProviders.includes(provider);
  }

  function resolvePendingAskUser(
    text: string,
    ctx: {
      hasUI: boolean;
      model: ExtensionContext["model"];
      ui: { setStatus: (key: string, text?: string) => void };
    }
  ): boolean {
    if (!pendingAskUserResolve) return false;

    const resolve = pendingAskUserResolve;
    pendingAskUserResolve = undefined;
    updateStatus(ctx, state, false);
    resolve(text);
    return true;
  }

  function syncState(
    ctx: Pick<ExtensionContext, "sessionManager" | "hasUI" | "ui" | "model">
  ): void {
    refreshConfiguredProviders();
    state = restoreFromContext(ctx);
    currentRunStarted = false;
    currentRunAskUserCallCount = 0;
    updateStatus(ctx, state, hasPendingAskUser());
  }

  pi.on("session_start", (_event, ctx) => syncState(ctx));
  pi.on("session_switch", (_event, ctx) => syncState(ctx));
  pi.on("session_tree", (_event, ctx) => syncState(ctx));
  pi.on("session_fork", (_event, ctx) => syncState(ctx));
  pi.on("model_select", (_event, ctx) => updateStatus(ctx, state, hasPendingAskUser()));
  pi.on("session_compact", (_event, ctx) => {
    // Compaction can prune earlier custom entries; persist current state again
    // so queue/autopilot/session settings remain available after reloads.
    persistState(pi, state);
    updateStatus(ctx, state, hasPendingAskUser());
  });

  pi.on("before_agent_start", (event, ctx) => {
    if (!isManagedProvider(ctx)) {
      return;
    }

    currentRunStarted = true;
    currentRunAskUserCallCount = 0;

    return {
      message: {
        customType: `${STATE_ENTRY_TYPE}:policy`,
        content: COPILOT_ASK_USER_REMINDER_MESSAGE,
        display: false,
      },
      systemPrompt: `${event.systemPrompt}\n\n${COPILOT_ASK_USER_POLICY}`,
    };
  });

  onBeforeProviderRequest(pi, (event, ctx) => {
    if (!isManagedProvider(ctx)) {
      return event.payload;
    }

    return forceRequiredToolChoice(event.payload);
  });

  pi.on("tool_call", (event, ctx) => {
    if (!isManagedProvider(ctx)) {
      return;
    }
    if (event.toolName !== TOOL_NAME) {
      return;
    }

    currentRunAskUserCallCount += 1;

    let nextState: QueueState = {
      ...state,
      toolCallCount: state.toolCallCount + 1,
    };
    nextState = applySessionWarnings(nextState, ctx);
    state = nextState;
    persistState(pi, state);
    updateStatus(ctx, state, hasPendingAskUser());
  });

  pi.on("agent_end", (event, ctx) => {
    if (!isManagedProvider(ctx) || !currentRunStarted) {
      return;
    }

    currentRunStarted = false;

    const lastAssistantReply = getLastAssistantReplyText(event.messages);
    const missedAskUser = currentRunAskUserCallCount === 0 && lastAssistantReply.length > 0;

    state = {
      ...state,
      completedRunCount: state.completedRunCount + 1,
      askUserRunCount: state.askUserRunCount + (currentRunAskUserCallCount > 0 ? 1 : 0),
      missedAskUserRunCount: state.missedAskUserRunCount + (missedAskUser ? 1 : 0),
      lastMissedAssistantReply: missedAskUser
        ? truncateReplyPreview(lastAssistantReply)
        : state.lastMissedAssistantReply,
    };

    persistState(pi, state);
    updateStatus(ctx, state, hasPendingAskUser());

    if (missedAskUser) {
      notify(
        ctx,
        "Copilot Queue: run ended with a direct assistant reply and never called ask_user.",
        "warning"
      );
    }
  });

  pi.on("input", (event, ctx) => {
    if (!isManagedProvider(ctx)) {
      return { action: "continue" };
    }

    if (event.source !== "interactive") {
      return { action: "continue" };
    }

    if (ctx.isIdle()) {
      return { action: "continue" };
    }

    if (!state.captureInteractiveInput) {
      return { action: "continue" };
    }

    const text = event.text.trim();
    if (!text) {
      return { action: "handled" };
    }

    if (resolvePendingAskUser(text, ctx)) {
      state = { ...state, stopRequested: false };
      persistState(pi, state);
      notify(ctx, "Busy run: sent your input to waiting ask_user.");
      return { action: "handled" };
    }

    state = { ...state, stopRequested: false, queue: [...state.queue, text] };
    persistState(pi, state);
    updateStatus(ctx, state, hasPendingAskUser());
    notify(ctx, `Busy run: queued follow-up (#${state.queue.length}).`);
    return { action: "handled" };
  });

  pi.registerCommand(EXTENSION_COMMAND, {
    description: "Queue responses for ask_user tool calls",
    getArgumentCompletions: (prefix: string) => buildProviderArgumentCompletions(prefix),
    handler: (args, ctx) => {
      const command = parseCommand(args);

      switch (command.name) {
        case "add": {
          if (!command.value) {
            notify(ctx, "Missing message. Usage: /copilot-queue add <message>");
            return Promise.resolve();
          }

          if (resolvePendingAskUser(command.value, ctx)) {
            state = { ...state, stopRequested: false };
            persistState(pi, state);
            notify(ctx, "Delivered message to waiting ask_user.");
            return Promise.resolve();
          }

          state = { ...state, stopRequested: false, queue: [...state.queue, command.value] };
          persistState(pi, state);
          updateStatus(ctx, state, hasPendingAskUser());
          notify(ctx, `Queued (#${state.queue.length}): ${command.value}`);
          return Promise.resolve();
        }

        case "list": {
          if (state.queue.length === 0) {
            notify(ctx, "Queue is empty.");
            return Promise.resolve();
          }
          const lines = state.queue.map((item, i) => `${i + 1}. ${item}`);
          notify(ctx, `Queued messages (${state.queue.length}):\n${lines.join("\n")}`);
          return Promise.resolve();
        }

        case "clear": {
          state = { ...state, queue: [] };
          persistState(pi, state);
          updateStatus(ctx, state, hasPendingAskUser());
          notify(ctx, "Queue cleared.");
          return Promise.resolve();
        }

        case "done":
        case "stop": {
          state = {
            ...state,
            queue: [],
            stopRequested: true,
            autopilotEnabled: false,
          };
          persistState(pi, state);
          const released = resolvePendingAskUser(STOP_RESPONSE, ctx);
          if (released) {
            state = { ...state, stopRequested: false };
            persistState(pi, state);
          }
          updateStatus(ctx, state, hasPendingAskUser());
          notify(
            ctx,
            released
              ? "Released waiting ask_user with 'stop'. Queue cleared and autopilot disabled."
              : "Stop requested. Queue cleared and autopilot disabled. The next ask_user call will receive 'stop'."
          );
          return Promise.resolve();
        }

        case "capture": {
          const mode = command.mode.trim().toLowerCase();
          if (!mode) {
            notify(
              ctx,
              `Interactive capture is ${state.captureInteractiveInput ? "on" : "off"}. Usage: /${EXTENSION_COMMAND} capture <on|off>`
            );
            return Promise.resolve();
          }

          if (mode !== "on" && mode !== "off") {
            notify(ctx, `Usage: /${EXTENSION_COMMAND} capture <on|off>`);
            return Promise.resolve();
          }

          state = { ...state, captureInteractiveInput: mode === "on" };
          persistState(pi, state);
          updateStatus(ctx, state, hasPendingAskUser());
          notify(
            ctx,
            `Interactive input capture ${state.captureInteractiveInput ? "enabled" : "disabled"}.`
          );
          return Promise.resolve();
        }

        case "providers": {
          refreshConfiguredProviders();
          const raw = command.value.trim();
          const { scope, value } = parseProviderScope(raw);
          const mode = value.toLowerCase();
          if (!raw || mode === "show" || mode === "list" || mode === "status") {
            notify(ctx, buildConfiguredProvidersText());
            return Promise.resolve();
          }

          if (mode === "off" || mode === "clear") {
            const scopeLabel = scope === "global" ? "Global" : "Project";
            const path =
              scope === "global"
                ? writeGlobalConfiguredProviders(process.cwd(), [])
                : writeProjectConfiguredProviders(process.cwd(), []);
            refreshConfiguredProviders();
            updateStatus(ctx, state, hasPendingAskUser());
            notify(ctx, `${scopeLabel} providers disabled. Saved to ${path}.`);
            return Promise.resolve();
          }

          const values = /^set(?:\s+|$)/i.test(value)
            ? value.replace(/^set\s*/i, "").trim()
            : value;
          const providers = values
            .split(/[\s,]+/)
            .map((item) => item.trim())
            .filter(Boolean);

          if (providers.length === 0) {
            notify(ctx, `Usage: /${EXTENSION_COMMAND} providers [global|project] <name... | off>`);
            return Promise.resolve();
          }

          const scopeLabel = scope === "global" ? "Global" : "Project";
          const path =
            scope === "global"
              ? writeGlobalConfiguredProviders(process.cwd(), providers)
              : writeProjectConfiguredProviders(process.cwd(), providers);
          refreshConfiguredProviders();
          updateStatus(ctx, state, hasPendingAskUser());
          notify(
            ctx,
            `${scopeLabel} providers updated: ${providers.join(", ")}. Saved to ${path}.`
          );
          return Promise.resolve();
        }

        case "fallback": {
          if (!command.value) {
            notify(ctx, `Fallback response: ${state.fallbackResponse}`);
            return Promise.resolve();
          }
          state = { ...state, fallbackResponse: command.value };
          persistState(pi, state);
          notify(ctx, `Fallback response updated: ${state.fallbackResponse}`);
          return Promise.resolve();
        }

        case "autopilot-on": {
          state = { ...state, autopilotEnabled: true };
          persistState(pi, state);
          updateStatus(ctx, state, hasPendingAskUser());
          notify(ctx, "Autopilot enabled.");
          return Promise.resolve();
        }

        case "autopilot-off": {
          state = { ...state, autopilotEnabled: false };
          persistState(pi, state);
          updateStatus(ctx, state, hasPendingAskUser());
          notify(ctx, "Autopilot disabled.");
          return Promise.resolve();
        }

        case "autopilot-add": {
          if (!command.value) {
            notify(ctx, "Missing message. Usage: /copilot-queue autopilot add <message>");
            return Promise.resolve();
          }
          state = { ...state, autopilotPrompts: [...state.autopilotPrompts, command.value] };
          persistState(pi, state);
          updateStatus(ctx, state, hasPendingAskUser());
          notify(ctx, `Autopilot prompt added (#${state.autopilotPrompts.length}).`);
          return Promise.resolve();
        }

        case "autopilot-list": {
          if (state.autopilotPrompts.length === 0) {
            notify(ctx, "Autopilot prompt list is empty.");
            return Promise.resolve();
          }
          const lines = state.autopilotPrompts.map((item, i) => `${i + 1}. ${item}`);
          notify(
            ctx,
            `Autopilot prompts (${state.autopilotPrompts.length}, ${state.autopilotEnabled ? "enabled" : "disabled"}):\n${lines.join("\n")}`
          );
          return Promise.resolve();
        }

        case "autopilot-clear": {
          state = { ...state, autopilotPrompts: [], autopilotIndex: 0 };
          persistState(pi, state);
          updateStatus(ctx, state, hasPendingAskUser());
          notify(ctx, "Autopilot prompts cleared.");
          return Promise.resolve();
        }

        case "session-status": {
          notify(ctx, buildSessionStatusText(state));
          return Promise.resolve();
        }

        case "session-reset": {
          state = {
            ...state,
            sessionStartedAt: Date.now(),
            toolCallCount: 0,
            stopRequested: false,
            completedRunCount: 0,
            askUserRunCount: 0,
            missedAskUserRunCount: 0,
            lastMissedAssistantReply: "",
            warnedTime: false,
            warnedToolCalls: false,
          };
          persistState(pi, state);
          updateStatus(ctx, state, hasPendingAskUser());
          notify(ctx, "Session counters reset.");
          return Promise.resolve();
        }

        case "session-threshold": {
          const minutes = parsePositiveInt(command.minutes);
          const toolCalls = parsePositiveInt(command.toolCalls);
          if (minutes === undefined || toolCalls === undefined) {
            notify(ctx, `Usage: /${EXTENSION_COMMAND} session threshold <minutes> <tool-calls>`);
            return Promise.resolve();
          }

          let nextState: QueueState = {
            ...state,
            warningMinutes: minutes,
            warningToolCalls: toolCalls,
            warnedTime: false,
            warnedToolCalls: false,
          };
          nextState = applySessionWarnings(nextState, ctx);
          state = nextState;
          persistState(pi, state);
          updateStatus(ctx, state, hasPendingAskUser());
          notify(
            ctx,
            `Session warning thresholds updated: ${state.warningMinutes} minutes, ${state.warningToolCalls} tool calls.`
          );
          return Promise.resolve();
        }

        case "wait-timeout": {
          const trimmedSeconds = command.seconds.trim();
          if (!trimmedSeconds) {
            notify(ctx, `Wait timeout: ${state.waitTimeoutSeconds} seconds (0 = disabled).`);
            return Promise.resolve();
          }

          const seconds = parseNonNegativeInt(trimmedSeconds);
          if (seconds === undefined) {
            notify(ctx, `Usage: /${EXTENSION_COMMAND} wait-timeout <seconds>`);
            return Promise.resolve();
          }

          state = { ...state, waitTimeoutSeconds: seconds };
          persistState(pi, state);
          notify(ctx, `Wait timeout updated: ${state.waitTimeoutSeconds} seconds.`);
          return Promise.resolve();
        }

        case "help":
        default:
          notify(ctx, buildHelpText());
          return Promise.resolve();
      }
    },
  });

  pi.registerTool({
    name: TOOL_NAME,
    label: "Ask User (Queue-Aware)",
    description: `For configured providers: call this instead of ending with a direct assistant reply. Returns the next queued response first, then autopilot prompts in cycle mode. If queue is empty in UI mode, waits for /copilot-queue add or /copilot-queue done.`,
    parameters: Type.Object({
      prompt: Type.Optional(
        Type.String({ description: "Question to display when queue and autopilot are empty" })
      ),
    }),
    renderCall(args, theme) {
      const prompt = args.prompt;
      let text = theme.fg("toolTitle", theme.bold(`${TOOL_NAME} `));
      if (prompt) {
        text += theme.fg("dim", prompt);
      } else {
        text += theme.fg("dim", "Waiting for user input...");
      }
      return new Text(text, 0, 0);
    },
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      if (!isManagedProvider(ctx)) {
        return askManuallyOrFallback(params.prompt, ctx, state.fallbackResponse);
      }

      if (state.stopRequested) {
        state = { ...state, stopRequested: false };
        persistState(pi, state);
        updateStatus(ctx, state, hasPendingAskUser());
        return {
          content: [{ type: "text", text: STOP_RESPONSE }],
          details: { source: "stop", remaining: state.queue.length },
        };
      }

      const queued = state.queue[0];
      if (queued) {
        state = { ...state, queue: state.queue.slice(1) };
        persistState(pi, state);
        updateStatus(ctx, state, hasPendingAskUser());
        notify(ctx, `Dequeued response (${state.queue.length} left).`);
        return {
          content: [{ type: "text", text: queued }],
          details: { source: "queue", remaining: state.queue.length },
        };
      }

      if (state.autopilotEnabled && state.autopilotPrompts.length > 0) {
        const index = state.autopilotIndex % state.autopilotPrompts.length;
        const text = state.autopilotPrompts[index] ?? state.fallbackResponse;
        state = {
          ...state,
          autopilotIndex: (index + 1) % state.autopilotPrompts.length,
        };
        persistState(pi, state);
        updateStatus(ctx, state, hasPendingAskUser());
        return {
          content: [{ type: "text", text }],
          details: { source: "autopilot", remaining: 0 },
        };
      }

      if (!ctx.hasUI) {
        return {
          content: [{ type: "text" as const, text: state.fallbackResponse }],
          details: { source: "fallback", remaining: 0 },
        };
      }

      const text = await waitForQueueInput({
        signal,
        ctx,
        fallbackResponse: state.fallbackResponse,
        timeoutSeconds: state.waitTimeoutSeconds,
        isWaiting: hasPendingAskUser,
        markWaiting: (resolve) => {
          pendingAskUserResolve = resolve;
          updateStatus(ctx, state, true);
        },
      });

      const source =
        text.source === "stop" ? "stop" : text.source === "timeout" ? "fallback" : "queue-live";
      return {
        content: [{ type: "text", text: text.value }],
        details: { source, remaining: state.queue.length },
      };
    },
  });

  function applySessionWarnings(
    current: QueueState,
    ctx: { hasUI: boolean; ui: { notify: (message: string, level: "info" | "warning") => void } }
  ): QueueState {
    let next = current;
    const elapsedMinutes = getElapsedMinutes(next);

    if (!next.warnedTime && elapsedMinutes >= next.warningMinutes) {
      next = { ...next, warnedTime: true };
      notify(
        ctx,
        `Session hygiene warning: ${formatElapsed(next)} elapsed. Consider starting a new session after 2-4 hours or around 50 tool calls.`,
        "warning"
      );
    }

    if (!next.warnedToolCalls && next.toolCallCount >= next.warningToolCalls) {
      next = { ...next, warnedToolCalls: true };
      notify(
        ctx,
        `Session hygiene warning: ${next.toolCallCount} tool calls reached. Consider starting a new session after 2-4 hours or around 50 tool calls.`,
        "warning"
      );
    }

    return next;
  }
}

function parsePositiveInt(raw: string): number | undefined {
  const trimmed = raw.trim();
  if (!/^\d+$/.test(trimmed)) return undefined;
  const value = Number(trimmed);
  if (!Number.isInteger(value) || value <= 0) return undefined;
  return value;
}

function parseNonNegativeInt(raw: string): number | undefined {
  const trimmed = raw.trim();
  if (!/^\d+$/.test(trimmed)) return undefined;
  const value = Number(trimmed);
  if (!Number.isInteger(value) || value < 0) return undefined;
  return value;
}

function buildSessionStatusText(state: QueueState): string {
  const elapsed = formatElapsed(state);
  const compliance = formatComplianceRate(state);
  const lastMiss = state.lastMissedAssistantReply
    ? `- Last missed direct reply: ${state.lastMissedAssistantReply}`
    : undefined;

  return [
    `Session status:`,
    `- Managed providers: ${getConfiguredProviderLabel()}`,
    `- Elapsed: ${elapsed}`,
    `- Tool calls: ${state.toolCallCount}`,
    `- Completed managed-provider runs: ${state.completedRunCount}`,
    `- Runs with ask_user: ${state.askUserRunCount}`,
    `- Direct replies without ask_user: ${state.missedAskUserRunCount}`,
    `- ask_user compliance: ${compliance}`,
    `- Warning thresholds: ${state.warningMinutes} minutes, ${state.warningToolCalls} tool calls`,
    `- Wait timeout: ${state.waitTimeoutSeconds} seconds (0 = disabled)`,
    `- Interactive capture while busy: ${state.captureInteractiveInput ? "on" : "off"}`,
    `- Stop requested: ${state.stopRequested ? "yes" : "no"}`,
    `- Time warning emitted: ${state.warnedTime ? "yes" : "no"}`,
    `- Tool-call warning emitted: ${state.warnedToolCalls ? "yes" : "no"}`,
    lastMiss,
  ]
    .filter((line): line is string => Boolean(line))
    .join("\n");
}

function getConfiguredProviderLabel(): string {
  return configuredProviders.length > 0 ? configuredProviders.join(", ") : "(disabled)";
}

function buildConfiguredProvidersText(): string {
  return [
    `Copilot Queue provider settings:`,
    `- Active providers: ${getConfiguredProviderLabel()}`,
    `- Set this project: /${EXTENSION_COMMAND} providers <name...>`,
    `- Set global default: /${EXTENSION_COMMAND} providers global <name...>`,
    `- Disable this project: /${EXTENSION_COMMAND} providers off`,
    `- Disable global default: /${EXTENSION_COMMAND} providers global off`,
    `- Project file: .pi/settings.json`,
    `- Global file: ~/.pi/agent/settings.json`,
  ].join("\n");
}

function parseProviderScope(raw: string): { scope: "project" | "global"; value: string } {
  if (/^global(?:\s+|$)/i.test(raw)) {
    return { scope: "global", value: raw.replace(/^global\s*/i, "").trim() };
  }

  if (/^project(?:\s+|$)/i.test(raw)) {
    return { scope: "project", value: raw.replace(/^project\s*/i, "").trim() };
  }

  return { scope: "project", value: raw };
}

function buildProviderArgumentCompletions(
  prefix: string
): { value: string; label: string }[] | null {
  const trimmed = prefix.trim();
  const suggestions = getProviderSuggestions(trimmed);

  if (suggestions.length === 0) {
    return null;
  }

  return suggestions.map((value) => ({ value, label: value }));
}

function getProviderSuggestions(prefix: string): string[] {
  const items = ["global", "project", "show", "list", "status", "set", "off", "clear"];
  if (!prefix) {
    return items;
  }

  const tokens = prefix.split(/\s+/);
  if (tokens.length === 1) {
    return items.filter((item) => item.startsWith(tokens[0] ?? ""));
  }

  const scope = tokens[0]?.toLowerCase();
  if (scope === "global" || scope === "project") {
    return ["set", "off", "clear", "show", "list", "status"].filter((item) =>
      item.startsWith(tokens[tokens.length - 1] ?? "")
    );
  }

  return items.filter((item) => item.startsWith(tokens[tokens.length - 1] ?? ""));
}

function refreshConfiguredProviders(cwd: string = process.cwd()): void {
  configuredProviders = resolveConfiguredProviders(cwd);
}

function formatComplianceRate(state: QueueState): string {
  if (state.completedRunCount === 0) {
    return "n/a (no completed runs yet)";
  }

  const percentage = (state.askUserRunCount / state.completedRunCount) * 100;
  return `${percentage.toFixed(1)}%`;
}

function getLastAssistantReplyText(messages: unknown): string {
  if (!Array.isArray(messages)) return "";

  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i] as unknown;
    if (!message || typeof message !== "object") continue;
    if ((message as { role?: unknown }).role !== "assistant") continue;
    return extractMessageText((message as { content?: unknown }).content);
  }

  return "";
}

function extractMessageText(content: unknown): string {
  if (typeof content === "string") {
    return content.trim();
  }

  if (!Array.isArray(content)) {
    return "";
  }

  return content
    .filter(
      (part): part is { type: "text"; text: string } =>
        Boolean(part) &&
        typeof part === "object" &&
        (part as { type?: unknown }).type === "text" &&
        typeof (part as { text?: unknown }).text === "string"
    )
    .map((part) => part.text.trim())
    .filter(Boolean)
    .join("\n")
    .trim();
}

function truncateReplyPreview(text: string): string {
  const singleLine = text.replace(/\s+/g, " ").trim();
  if (singleLine.length <= 120) {
    return singleLine;
  }
  return `${singleLine.slice(0, 117)}...`;
}

function onBeforeProviderRequest(
  pi: ExtensionAPI,
  handler: (event: { payload: unknown }, ctx: ExtensionContext) => unknown
): void {
  const extensionWithDynamicEvents = pi as ExtensionAPI & {
    on: (event: string, eventHandler: (event: unknown, ctx: ExtensionContext) => unknown) => void;
  };

  extensionWithDynamicEvents.on("before_provider_request", (event, ctx) => {
    if (!event || typeof event !== "object") {
      return undefined;
    }

    if (!("payload" in event)) {
      return undefined;
    }

    return handler(event as { payload: unknown }, ctx);
  });
}

function forceRequiredToolChoice(payload: unknown): unknown {
  if (!isOpenAiToolChoicePayload(payload)) {
    return payload;
  }

  if (!payload.tools.some(isAskUserOpenAiTool)) {
    return payload;
  }

  const currentToolChoice = payload.tool_choice;
  if (currentToolChoice === "required") {
    return payload;
  }

  if (currentToolChoice && typeof currentToolChoice === "object") {
    return payload;
  }

  return {
    ...payload,
    tool_choice: "required",
  };
}

function isOpenAiToolChoicePayload(payload: unknown): payload is {
  tools: unknown[];
  tool_choice?: unknown;
} {
  if (!payload || typeof payload !== "object") {
    return false;
  }

  if (!("tools" in payload)) {
    return false;
  }

  const tools = (payload as { tools?: unknown }).tools;
  if (!Array.isArray(tools)) {
    return false;
  }

  return tools.some(isOpenAiFunctionTool);
}

function isOpenAiFunctionTool(tool: unknown): boolean {
  if (!tool || typeof tool !== "object") {
    return false;
  }

  const candidate = tool as {
    type?: unknown;
    function?: unknown;
    name?: unknown;
  };

  if (candidate.type === "function") {
    return true;
  }

  return typeof candidate.function === "object" || typeof candidate.name === "string";
}

function isAskUserOpenAiTool(tool: unknown): boolean {
  if (!tool || typeof tool !== "object") {
    return false;
  }

  const candidate = tool as {
    name?: unknown;
    function?: unknown;
  };

  if (candidate.name === TOOL_NAME) {
    return true;
  }

  if (!candidate.function || typeof candidate.function !== "object") {
    return false;
  }

  return (candidate.function as { name?: unknown }).name === TOOL_NAME;
}

async function askManuallyOrFallback(
  prompt: string | undefined,
  ctx: ExtensionContext,
  fallbackResponse: string
) {
  if (ctx.hasUI) {
    const title = "Copilot Queue";
    const question =
      prompt?.trim() || "Agent asked for feedback. Your response (blank = fallback response):";
    const response = await ctx.ui.input(title, question);
    const text = response?.trim() || fallbackResponse;
    return {
      content: [{ type: "text" as const, text }],
      details: { source: response?.trim() ? "manual" : "fallback", remaining: 0 },
    };
  }

  return {
    content: [{ type: "text" as const, text: fallbackResponse }],
    details: { source: "fallback", remaining: 0 },
  };
}

async function waitForQueueInput(options: {
  signal: AbortSignal | undefined;
  ctx: { hasUI: boolean; ui: { notify: (message: string, level: "info" | "warning") => void } };
  fallbackResponse: string;
  timeoutSeconds: number;
  isWaiting: () => boolean;
  markWaiting: (resolve: (text: string) => void) => void;
}): Promise<{ value: string; source: "queue-live" | "stop" | "timeout" }> {
  const { signal, ctx, fallbackResponse, timeoutSeconds, isWaiting, markWaiting } = options;

  if (signal?.aborted) {
    return { value: fallbackResponse, source: "timeout" };
  }

  if (!isWaiting()) {
    const timeoutText =
      timeoutSeconds > 0
        ? ` Waiting up to ${timeoutSeconds} seconds before fallback.`
        : " Waiting without timeout.";
    notify(
      ctx,
      `Queue empty. Waiting for /copilot-queue add <message>, /copilot-queue done, or /copilot-queue stop.${timeoutText}`
    );
    // Send native terminal notification for multitasking users
    notifyTerminal("Pi", "ask_user waiting for input");
  }

  return new Promise<{ value: string; source: "queue-live" | "stop" | "timeout" }>((resolve) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const settle = (result: { value: string; source: "queue-live" | "stop" | "timeout" }) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      resolve(result);
    };

    const onAbort = () => settle({ value: fallbackResponse, source: "timeout" });
    signal?.addEventListener("abort", onAbort, { once: true });

    if (timeoutSeconds > 0) {
      timer = setTimeout(() => {
        notify(
          ctx,
          `No queued response received within ${timeoutSeconds} seconds. Returning fallback response.`,
          "warning"
        );
        settle({ value: fallbackResponse, source: "timeout" });
      }, timeoutSeconds * 1000);
    }

    markWaiting((text) =>
      settle({ value: text, source: text === STOP_RESPONSE ? "stop" : "queue-live" })
    );
  });
}

function initialState(): QueueState {
  return {
    queue: [],
    fallbackResponse: DEFAULT_FALLBACK_RESPONSE,
    captureInteractiveInput: true,
    stopRequested: false,
    autopilotEnabled: false,
    autopilotPrompts: [],
    autopilotIndex: 0,
    sessionStartedAt: Date.now(),
    toolCallCount: 0,
    completedRunCount: 0,
    askUserRunCount: 0,
    missedAskUserRunCount: 0,
    lastMissedAssistantReply: "",
    warningMinutes: DEFAULT_WARNING_MINUTES,
    warningToolCalls: DEFAULT_WARNING_TOOL_CALLS,
    waitTimeoutSeconds: DEFAULT_WAIT_TIMEOUT_SECONDS,
    warnedTime: false,
    warnedToolCalls: false,
  };
}

function persistState(pi: ExtensionAPI, state: QueueState): void {
  pi.appendEntry(STATE_ENTRY_TYPE, state);
}

function updateStatus(
  ctx: {
    hasUI: boolean;
    model: ExtensionContext["model"];
    ui: { setStatus: (key: string, text?: string) => void };
  },
  state: QueueState,
  waitingForQueue: boolean
): void {
  if (!ctx.hasUI) return;
  if (!ctx.model?.provider || !configuredProviders.includes(ctx.model.provider)) {
    ctx.ui.setStatus(EXTENSION_COMMAND);
    return;
  }

  const autopilot = state.autopilotEnabled
    ? `autopilot:${state.autopilotPrompts.length}`
    : "autopilot:off";
  const capture = state.captureInteractiveInput ? "capture:on" : "capture:off";
  const waiting = waitingForQueue ? " | waiting:input" : "";
  const misses = state.missedAskUserRunCount > 0 ? ` · miss:${state.missedAskUserRunCount}` : "";
  const session = `${formatElapsed(state)} · ${state.toolCallCount} tools${misses}`;
  ctx.ui.setStatus(
    EXTENSION_COMMAND,
    `${EXTENSION_NAME}: ${state.queue.length} queued${waiting} | ${autopilot} | ${capture} | ${session}`
  );
}

function restoreFromContext(ctx: Pick<ExtensionContext, "sessionManager">): QueueState {
  const entries = ctx.sessionManager.getBranch();

  for (let i = entries.length - 1; i >= 0; i -= 1) {
    const entry = entries[i];
    if (entry?.type !== "custom" || entry.customType !== STATE_ENTRY_TYPE) continue;
    const restored = parseQueueState(entry.data);
    if (restored) return restored;
  }

  return initialState();
}

function parseQueueState(value: unknown): QueueState | undefined {
  if (!value || typeof value !== "object") return undefined;
  const candidate = value as {
    queue?: unknown;
    fallbackResponse?: unknown;
    captureInteractiveInput?: unknown;
    stopRequested?: unknown;
    autopilotEnabled?: unknown;
    autopilotPrompts?: unknown;
    autopilotIndex?: unknown;
    sessionStartedAt?: unknown;
    toolCallCount?: unknown;
    completedRunCount?: unknown;
    askUserRunCount?: unknown;
    missedAskUserRunCount?: unknown;
    lastMissedAssistantReply?: unknown;
    warningMinutes?: unknown;
    warningToolCalls?: unknown;
    waitTimeoutSeconds?: unknown;
    warnedTime?: unknown;
    warnedToolCalls?: unknown;
  };

  if (
    !Array.isArray(candidate.queue) ||
    !candidate.queue.every((item) => typeof item === "string")
  ) {
    return undefined;
  }

  if (typeof candidate.fallbackResponse !== "string") return undefined;

  const captureInteractiveInput =
    typeof candidate.captureInteractiveInput === "boolean"
      ? candidate.captureInteractiveInput
      : true;

  const stopRequested =
    typeof candidate.stopRequested === "boolean" ? candidate.stopRequested : false;

  const autopilotPrompts = Array.isArray(candidate.autopilotPrompts)
    ? candidate.autopilotPrompts.filter((item): item is string => typeof item === "string")
    : [];

  const autopilotEnabled =
    typeof candidate.autopilotEnabled === "boolean" ? candidate.autopilotEnabled : false;
  const rawIndex = typeof candidate.autopilotIndex === "number" ? candidate.autopilotIndex : 0;
  const autopilotIndex = Number.isInteger(rawIndex) && rawIndex >= 0 ? rawIndex : 0;

  const rawStartedAt =
    typeof candidate.sessionStartedAt === "number" ? candidate.sessionStartedAt : Date.now();
  const sessionStartedAt =
    Number.isFinite(rawStartedAt) && rawStartedAt > 0 ? rawStartedAt : Date.now();

  const rawToolCallCount =
    typeof candidate.toolCallCount === "number" ? candidate.toolCallCount : 0;
  const toolCallCount =
    Number.isInteger(rawToolCallCount) && rawToolCallCount >= 0 ? rawToolCallCount : 0;

  const rawCompletedRunCount =
    typeof candidate.completedRunCount === "number" ? candidate.completedRunCount : 0;
  const completedRunCount =
    Number.isInteger(rawCompletedRunCount) && rawCompletedRunCount >= 0 ? rawCompletedRunCount : 0;

  const rawAskUserRunCount =
    typeof candidate.askUserRunCount === "number" ? candidate.askUserRunCount : 0;
  const askUserRunCount =
    Number.isInteger(rawAskUserRunCount) && rawAskUserRunCount >= 0 ? rawAskUserRunCount : 0;

  const rawMissedAskUserRunCount =
    typeof candidate.missedAskUserRunCount === "number" ? candidate.missedAskUserRunCount : 0;
  const missedAskUserRunCount =
    Number.isInteger(rawMissedAskUserRunCount) && rawMissedAskUserRunCount >= 0
      ? rawMissedAskUserRunCount
      : 0;

  const lastMissedAssistantReply =
    typeof candidate.lastMissedAssistantReply === "string"
      ? candidate.lastMissedAssistantReply
      : "";

  const rawWarningMinutes =
    typeof candidate.warningMinutes === "number"
      ? candidate.warningMinutes
      : DEFAULT_WARNING_MINUTES;
  const warningMinutes =
    Number.isInteger(rawWarningMinutes) && rawWarningMinutes > 0
      ? rawWarningMinutes
      : DEFAULT_WARNING_MINUTES;

  const rawWarningToolCalls =
    typeof candidate.warningToolCalls === "number"
      ? candidate.warningToolCalls
      : DEFAULT_WARNING_TOOL_CALLS;
  const warningToolCalls =
    Number.isInteger(rawWarningToolCalls) && rawWarningToolCalls > 0
      ? rawWarningToolCalls
      : DEFAULT_WARNING_TOOL_CALLS;

  const rawWaitTimeoutSeconds =
    typeof candidate.waitTimeoutSeconds === "number"
      ? candidate.waitTimeoutSeconds
      : DEFAULT_WAIT_TIMEOUT_SECONDS;
  const waitTimeoutSeconds =
    Number.isInteger(rawWaitTimeoutSeconds) && rawWaitTimeoutSeconds >= 0
      ? rawWaitTimeoutSeconds
      : DEFAULT_WAIT_TIMEOUT_SECONDS;

  const warnedTime = typeof candidate.warnedTime === "boolean" ? candidate.warnedTime : false;
  const warnedToolCalls =
    typeof candidate.warnedToolCalls === "boolean" ? candidate.warnedToolCalls : false;

  return {
    queue: candidate.queue,
    fallbackResponse: candidate.fallbackResponse,
    captureInteractiveInput,
    stopRequested,
    autopilotEnabled,
    autopilotPrompts,
    autopilotIndex,
    sessionStartedAt,
    toolCallCount,
    completedRunCount,
    askUserRunCount,
    missedAskUserRunCount,
    lastMissedAssistantReply,
    warningMinutes,
    warningToolCalls,
    waitTimeoutSeconds,
    warnedTime,
    warnedToolCalls,
  };
}

function getElapsedMinutes(state: QueueState): number {
  const elapsedMs = Math.max(0, Date.now() - state.sessionStartedAt);
  return Math.floor(elapsedMs / 60000);
}

function formatElapsed(state: QueueState): string {
  const elapsedMs = Math.max(0, Date.now() - state.sessionStartedAt);
  const totalMinutes = Math.floor(elapsedMs / 60000);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return `${hours}h${String(minutes).padStart(2, "0")}m`;
}

function notify(
  ctx: { hasUI: boolean; ui: { notify: (message: string, level: "info" | "warning") => void } },
  message: string,
  level: "info" | "warning" = "info"
): void {
  if (ctx.hasUI) {
    ctx.ui.notify(message, level);
  } else {
    console.log(message);
  }
}
