import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import {
  ACTIVE_PROVIDER,
  COPILOT_ASK_USER_POLICY,
  DEFAULT_FALLBACK_RESPONSE,
  DEFAULT_WAIT_TIMEOUT_SECONDS,
  DEFAULT_WARNING_MINUTES,
  DEFAULT_WARNING_TOOL_CALLS,
  EXTENSION_COMMAND,
  EXTENSION_NAME,
  STATE_ENTRY_TYPE,
  TOOL_NAME,
} from "./constants.js";
import { buildHelpText, parseCommand } from "./commands.js";
import type { QueueState } from "./types.js";

const DONE_RESPONSE = "done";

export default function copilotQueueExtension(pi: ExtensionAPI) {
  let state: QueueState = initialState();
  let pendingAskUserResolve: ((text: string) => void) | undefined;
  let reinjectPolicyAfterCompaction = false;

  function hasPendingAskUser(): boolean {
    return Boolean(pendingAskUserResolve);
  }

  function resolvePendingAskUser(
    text: string,
    ctx: { hasUI: boolean; ui: { setStatus: (key: string, text?: string) => void } }
  ): boolean {
    if (!pendingAskUserResolve) return false;

    const resolve = pendingAskUserResolve;
    pendingAskUserResolve = undefined;
    updateStatus(ctx, state, false);
    resolve(text);
    return true;
  }

  function syncState(ctx: Pick<ExtensionContext, "sessionManager" | "hasUI" | "ui">): void {
    state = restoreFromContext(ctx);
    updateStatus(ctx, state, hasPendingAskUser());
  }

  pi.on("session_start", (_event, ctx) => syncState(ctx));
  pi.on("session_switch", (_event, ctx) => syncState(ctx));
  pi.on("session_tree", (_event, ctx) => syncState(ctx));
  pi.on("session_fork", (_event, ctx) => syncState(ctx));
  pi.on("session_compact", (_event, ctx) => {
    reinjectPolicyAfterCompaction = true;
    // Compaction can prune earlier custom entries; persist current state again
    // so queue/autopilot/session settings remain available after reloads.
    persistState(pi, state);
    updateStatus(ctx, state, hasPendingAskUser());
  });
  pi.on("context", (event, ctx) => {
    if (ctx.model?.provider !== ACTIVE_PROVIDER) {
      return;
    }
    if (!reinjectPolicyAfterCompaction) {
      return;
    }

    reinjectPolicyAfterCompaction = false;
    const reinforcementMessage = {
      role: "custom",
      customType: "copilot-queue:policy-reinforcement",
      content: COPILOT_ASK_USER_POLICY,
      display: false,
      timestamp: Date.now(),
    } as (typeof event.messages)[number];

    return {
      messages: [...event.messages, reinforcementMessage],
    };
  });

  pi.on("before_agent_start", (event, ctx) => {
    if (ctx.model?.provider !== ACTIVE_PROVIDER) {
      return;
    }

    return {
      systemPrompt: `${event.systemPrompt}\n\n${COPILOT_ASK_USER_POLICY}`,
    };
  });

  pi.on("tool_call", (event, ctx) => {
    if (ctx.model?.provider !== ACTIVE_PROVIDER) {
      return;
    }
    if (event.toolName !== TOOL_NAME) {
      return;
    }

    let nextState: QueueState = {
      ...state,
      toolCallCount: state.toolCallCount + 1,
    };
    nextState = applySessionWarnings(nextState, ctx);
    state = nextState;
    persistState(pi, state);
    updateStatus(ctx, state, hasPendingAskUser());
  });

  pi.on("input", (event, ctx) => {
    if (ctx.model?.provider !== ACTIVE_PROVIDER) {
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
      notify(ctx, "Busy run: sent your input to waiting ask_user.");
      return { action: "handled" };
    }

    state = { ...state, queue: [...state.queue, text] };
    persistState(pi, state);
    updateStatus(ctx, state, hasPendingAskUser());
    notify(ctx, `Busy run: queued follow-up (#${state.queue.length}).`);
    return { action: "handled" };
  });

  pi.registerCommand(EXTENSION_COMMAND, {
    description: "Queue responses for ask_user tool calls",
    handler: (args, ctx) => {
      const command = parseCommand(args);

      switch (command.name) {
        case "add": {
          if (!command.value) {
            notify(ctx, "Missing message. Usage: /copilot-queue add <message>");
            return Promise.resolve();
          }

          if (resolvePendingAskUser(command.value, ctx)) {
            notify(ctx, "Delivered message to waiting ask_user.");
            return Promise.resolve();
          }

          state = { ...state, queue: [...state.queue, command.value] };
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

        case "done": {
          state = { ...state, queue: [], autopilotEnabled: false };
          persistState(pi, state);
          const released = resolvePendingAskUser(DONE_RESPONSE, ctx);
          updateStatus(ctx, state, hasPendingAskUser());
          notify(
            ctx,
            released
              ? "Released waiting ask_user with 'done'. Queue cleared and autopilot disabled."
              : "Queue cleared and autopilot disabled."
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
    description:
      "For github-copilot provider: returns the next queued response first, then autopilot prompts in cycle mode. If queue is empty in UI mode, waits for /copilot-queue add or /copilot-queue done.",
    parameters: Type.Object({
      prompt: Type.Optional(
        Type.String({ description: "Question to display when queue and autopilot are empty" })
      ),
    }),
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      if (ctx.model?.provider !== ACTIVE_PROVIDER) {
        return askManuallyOrFallback(params.prompt, ctx, state.fallbackResponse);
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
        prompt: params.prompt,
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
        text.source === "done" ? "done" : text.source === "timeout" ? "fallback" : "queue-live";
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
  return [
    `Session status:`,
    `- Elapsed: ${elapsed}`,
    `- Tool calls: ${state.toolCallCount}`,
    `- Warning thresholds: ${state.warningMinutes} minutes, ${state.warningToolCalls} tool calls`,
    `- Wait timeout: ${state.waitTimeoutSeconds} seconds (0 = disabled)`,
    `- Interactive capture while busy: ${state.captureInteractiveInput ? "on" : "off"}`,
    `- Time warning emitted: ${state.warnedTime ? "yes" : "no"}`,
    `- Tool-call warning emitted: ${state.warnedToolCalls ? "yes" : "no"}`,
  ].join("\n");
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
  prompt: string | undefined;
  signal: AbortSignal | undefined;
  ctx: { hasUI: boolean; ui: { notify: (message: string, level: "info" | "warning") => void } };
  fallbackResponse: string;
  timeoutSeconds: number;
  isWaiting: () => boolean;
  markWaiting: (resolve: (text: string) => void) => void;
}): Promise<{ value: string; source: "queue-live" | "done" | "timeout" }> {
  const { prompt, signal, ctx, fallbackResponse, timeoutSeconds, isWaiting, markWaiting } = options;

  if (signal?.aborted) {
    return { value: fallbackResponse, source: "timeout" };
  }

  if (!isWaiting()) {
    const question = prompt?.trim() ?? "Agent requested feedback.";
    const timeoutText =
      timeoutSeconds > 0
        ? ` Waiting up to ${timeoutSeconds} seconds before fallback.`
        : " Waiting without timeout.";
    notify(
      ctx,
      `Queue empty. Waiting for /copilot-queue add <message> or /copilot-queue done.${timeoutText} Prompt: ${question}`
    );
  }

  return new Promise<{ value: string; source: "queue-live" | "done" | "timeout" }>((resolve) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const settle = (result: { value: string; source: "queue-live" | "done" | "timeout" }) => {
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
      settle({ value: text, source: text === DONE_RESPONSE ? "done" : "queue-live" })
    );
  });
}

function initialState(): QueueState {
  return {
    queue: [],
    fallbackResponse: DEFAULT_FALLBACK_RESPONSE,
    captureInteractiveInput: true,
    autopilotEnabled: false,
    autopilotPrompts: [],
    autopilotIndex: 0,
    sessionStartedAt: Date.now(),
    toolCallCount: 0,
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
  ctx: { hasUI: boolean; ui: { setStatus: (key: string, text?: string) => void } },
  state: QueueState,
  waitingForQueue: boolean
): void {
  if (!ctx.hasUI) return;
  const autopilot = state.autopilotEnabled
    ? `autopilot:${state.autopilotPrompts.length}`
    : "autopilot:off";
  const capture = state.captureInteractiveInput ? "capture:on" : "capture:off";
  const waiting = waitingForQueue ? " | waiting:input" : "";
  const session = `${formatElapsed(state)} · ${state.toolCallCount} tools`;
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
    autopilotEnabled?: unknown;
    autopilotPrompts?: unknown;
    autopilotIndex?: unknown;
    sessionStartedAt?: unknown;
    toolCallCount?: unknown;
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
    autopilotEnabled,
    autopilotPrompts,
    autopilotIndex,
    sessionStartedAt,
    toolCallCount,
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
