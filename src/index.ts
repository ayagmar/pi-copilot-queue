import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";
import { buildCommandArgumentCompletions, buildHelpText, parseCommand } from "./commands.js";
import {
  resolveCopilotQueueSettings,
  writeGlobalConfiguredProviders,
  writeShowStatusLine,
} from "./config.js";
import {
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
import { notifyTerminal } from "./notify.js";
import type { QueueState } from "./types.js";

const STOP_RESPONSE = "stop";
let configuredProviders: string[] = [];
let showStatusLine = true;

export default function copilotQueueExtension(pi: ExtensionAPI) {
  refreshConfiguration();

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
      ui: {
        setStatus: (key: string, text?: string) => void;
        theme?: StatusTheme;
      };
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
    refreshConfiguration();
    pendingAskUserResolve = undefined;
    state = restoreFromContext(ctx);
    currentRunStarted = false;
    currentRunAskUserCallCount = 0;
    updateStatus(ctx, state, false);
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
      systemPrompt: `${event.systemPrompt}\n\n${COPILOT_ASK_USER_POLICY}`,
    };
  });

  pi.on("tool_call", (event, ctx) => {
    if (!isManagedProvider(ctx)) {
      return;
    }

    if (event.toolName === TOOL_NAME) {
      currentRunAskUserCallCount += 1;
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
    getArgumentCompletions: (prefix: string) =>
      buildCommandArgumentCompletions(prefix, { configuredProviders }),
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
          refreshConfiguration();
          const raw = command.value.trim();
          if (/^project(?:\s+|$)/i.test(raw)) {
            notify(
              ctx,
              `Project-scoped providers are no longer supported. Usage: /${EXTENSION_COMMAND} providers <name... | off>`
            );
            return Promise.resolve();
          }

          const value = stripGlobalProviderPrefix(raw);
          const mode = value.toLowerCase();
          if (!raw || mode === "show" || mode === "list" || mode === "status") {
            notify(ctx, buildConfiguredProvidersText());
            return Promise.resolve();
          }

          if (mode === "off" || mode === "clear") {
            const path = writeGlobalConfiguredProviders([]);
            refreshConfiguration();
            updateStatus(ctx, state, hasPendingAskUser());
            notify(ctx, `Global providers disabled. Saved to ${path}.`);
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
            notify(ctx, `Usage: /${EXTENSION_COMMAND} providers <name... | off>`);
            return Promise.resolve();
          }

          const path = writeGlobalConfiguredProviders(providers);
          refreshConfiguration();
          updateStatus(ctx, state, hasPendingAskUser());
          notify(ctx, `Global providers updated: ${providers.join(", ")}. Saved to ${path}.`);
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

        case "settings": {
          refreshConfiguration();

          if (!ctx.hasUI) {
            notify(ctx, buildSettingsSummaryText(state));
            return Promise.resolve();
          }

          return openSettingsUi(ctx, {
            getState: () => state,
            getShowStatusLine: () => showStatusLine,
            getConfiguredProviders: () => configuredProviders,
            onCaptureChange: (enabled) => {
              state = { ...state, captureInteractiveInput: enabled };
              persistState(pi, state);
              updateStatus(ctx, state, hasPendingAskUser());
              notify(ctx, `Interactive input capture ${enabled ? "enabled" : "disabled"}.`);
            },
            onShowStatusLineChange: (enabled) => {
              writeShowStatusLine(enabled);
              refreshConfiguration();
              updateStatus(ctx, state, hasPendingAskUser());
              notify(ctx, `Global status line ${enabled ? "enabled" : "disabled"}.`);
            },
            onProvidersChange: (providers) => {
              writeGlobalConfiguredProviders(providers);
              refreshConfiguration();
              updateStatus(ctx, state, hasPendingAskUser());
              notify(
                ctx,
                `Global providers ${providers.length > 0 ? providers.join(", ") : "disabled"}.`
              );
            },
            onWaitTimeoutChange: (seconds) => {
              state = { ...state, waitTimeoutSeconds: seconds };
              persistState(pi, state);
              notify(ctx, `Wait timeout updated: ${seconds} seconds.`);
            },
            onFallbackChange: (fallbackResponse) => {
              state = { ...state, fallbackResponse };
              persistState(pi, state);
              notify(ctx, `Fallback response updated: ${fallbackResponse}`);
            },
            onWarningThresholdChange: (warningMinutes, warningToolCalls) => {
              let nextState: QueueState = {
                ...state,
                warningMinutes,
                warningToolCalls,
                warnedTime: false,
                warnedToolCalls: false,
              };
              nextState = applySessionWarnings(nextState, ctx);
              state = nextState;
              persistState(pi, state);
              updateStatus(ctx, state, hasPendingAskUser());
              notify(
                ctx,
                `Warning thresholds updated: ${warningMinutes} minutes, ${warningToolCalls} tool calls.`
              );
            },
            onAutopilotEnabledChange: (enabled) => {
              state = { ...state, autopilotEnabled: enabled };
              persistState(pi, state);
              updateStatus(ctx, state, hasPendingAskUser());
              notify(ctx, `Autopilot ${enabled ? "enabled" : "disabled"}.`);
            },
            onAutopilotPromptAdd: (prompt) => {
              state = { ...state, autopilotPrompts: [...state.autopilotPrompts, prompt] };
              persistState(pi, state);
              updateStatus(ctx, state, hasPendingAskUser());
              notify(ctx, `Autopilot prompt added (#${state.autopilotPrompts.length}).`);
            },
            onAutopilotPromptsClear: () => {
              state = { ...state, autopilotPrompts: [], autopilotIndex: 0 };
              persistState(pi, state);
              updateStatus(ctx, state, hasPendingAskUser());
              notify(ctx, "Autopilot prompts cleared.");
            },
          });
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
    description: `For configured providers: call this instead of ending with a direct assistant reply. Returns the next queued response first, then autopilot prompts in cycle mode. If queue is empty in UI mode, waits for /copilot-queue add, /copilot-queue done, or /copilot-queue stop.`,
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

      pendingAskUserResolve = undefined;
      updateStatus(ctx, state, false);

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
    `- Set global providers: /${EXTENSION_COMMAND} providers <name...>`,
    `- Disable global providers: /${EXTENSION_COMMAND} providers off`,
    `- Global file: ~/.pi/agent/settings.json`,
  ].join("\n");
}

function stripGlobalProviderPrefix(raw: string): string {
  if (/^global(?:\s+|$)/i.test(raw)) {
    return raw.replace(/^global\s*/i, "").trim();
  }

  return raw;
}

function buildSettingsSummaryText(state: QueueState): string {
  const timeout =
    state.waitTimeoutSeconds === 0 ? "off" : `${state.waitTimeoutSeconds} seconds before fallback`;

  return [
    `Copilot Queue settings:`,
    `- Managed providers: ${getConfiguredProviderLabel()}`,
    `- Busy input capture: ${state.captureInteractiveInput ? "on" : "off"}`,
    `- Status line: ${showStatusLine ? "on" : "off"}`,
    `- Empty-queue wait timeout: ${timeout}`,
    `- Fallback response: ${state.fallbackResponse}`,
    `- Warning thresholds: ${state.warningMinutes} minutes, ${state.warningToolCalls} tool calls`,
    `- Autopilot: ${state.autopilotEnabled ? "on" : "off"}`,
    `- Autopilot prompts: ${state.autopilotPrompts.length}`,
  ].join("\n");
}

async function openSettingsUi(
  ctx: ExtensionContext,
  options: {
    getState: () => QueueState;
    getShowStatusLine: () => boolean;
    getConfiguredProviders: () => string[];
    onCaptureChange: (enabled: boolean) => void;
    onShowStatusLineChange: (enabled: boolean) => void;
    onProvidersChange: (providers: string[]) => void;
    onWaitTimeoutChange: (seconds: number) => void;
    onFallbackChange: (fallbackResponse: string) => void;
    onWarningThresholdChange: (warningMinutes: number, warningToolCalls: number) => void;
    onAutopilotEnabledChange: (enabled: boolean) => void;
    onAutopilotPromptAdd: (prompt: string) => void;
    onAutopilotPromptsClear: () => void;
  }
): Promise<void> {
  while (true) {
    const state = options.getState();
    const selection = await ctx.ui.select("Copilot Queue Settings", [
      `Managed providers: ${options.getConfiguredProviders().join(", ") || "(disabled)"}`,
      `Busy input capture: ${state.captureInteractiveInput ? "on" : "off"}`,
      `Status line: ${options.getShowStatusLine() ? "on" : "off"}`,
      `Empty-queue wait timeout: ${formatWaitTimeoutLabel(state.waitTimeoutSeconds)}`,
      `Fallback response: ${state.fallbackResponse}`,
      `Warning thresholds: ${state.warningMinutes}m / ${state.warningToolCalls} tools`,
      `Autopilot: ${state.autopilotEnabled ? "on" : "off"}`,
      `Autopilot prompts: ${state.autopilotPrompts.length}`,
      "Close",
    ]);

    if (!selection || selection === "Close") {
      return;
    }

    if (selection.startsWith("Managed providers:")) {
      await editProvidersSetting(ctx, options);
      continue;
    }

    if (selection.startsWith("Busy input capture:")) {
      const enabled = await selectOnOff(ctx, "Busy input capture", state.captureInteractiveInput);
      if (enabled !== undefined) {
        options.onCaptureChange(enabled);
      }
      continue;
    }

    if (selection.startsWith("Status line:")) {
      const enabled = await selectOnOff(ctx, "Status line", options.getShowStatusLine());
      if (enabled !== undefined) {
        options.onShowStatusLineChange(enabled);
      }
      continue;
    }

    if (selection.startsWith("Empty-queue wait timeout:")) {
      const seconds = await editWaitTimeoutSetting(ctx, state.waitTimeoutSeconds);
      if (seconds !== undefined) {
        options.onWaitTimeoutChange(seconds);
      }
      continue;
    }

    if (selection.startsWith("Fallback response:")) {
      const fallbackResponse = await ctx.ui.input(
        "Fallback response",
        `Current: ${state.fallbackResponse}`
      );
      const trimmed = fallbackResponse?.trim();
      if (trimmed) {
        options.onFallbackChange(trimmed);
      }
      continue;
    }

    if (selection.startsWith("Warning thresholds:")) {
      const thresholds = await editWarningThresholdsSetting(
        ctx,
        state.warningMinutes,
        state.warningToolCalls
      );
      if (thresholds) {
        options.onWarningThresholdChange(thresholds.minutes, thresholds.toolCalls);
      }
      continue;
    }

    if (selection.startsWith("Autopilot:")) {
      const enabled = await selectOnOff(ctx, "Autopilot", state.autopilotEnabled);
      if (enabled !== undefined) {
        options.onAutopilotEnabledChange(enabled);
      }
      continue;
    }

    if (selection.startsWith("Autopilot prompts:")) {
      await editAutopilotPromptsSetting(ctx, state, options);
    }
  }
}

async function editProvidersSetting(
  ctx: ExtensionContext,
  options: {
    getConfiguredProviders: () => string[];
    onProvidersChange: (providers: string[]) => void;
  }
): Promise<void> {
  const selection = await ctx.ui.select("Managed providers", [
    "Set global providers",
    "Disable global providers",
    "Back",
  ]);

  if (!selection || selection === "Back") {
    return;
  }

  if (selection === "Disable global providers") {
    options.onProvidersChange([]);
    return;
  }

  const response = await ctx.ui.input(
    "Global managed providers",
    `Space- or comma-separated provider names. Active: ${options.getConfiguredProviders().join(", ") || "(disabled)"}`
  );

  if (response === undefined) {
    return;
  }

  const providers = response
    .split(/[\s,]+/)
    .map((item) => item.trim())
    .filter(Boolean);

  if (providers.length === 0) {
    notify(
      ctx,
      "No providers entered. Use the disable option to turn provider routing off.",
      "warning"
    );
    return;
  }

  options.onProvidersChange(providers);
}

async function selectOnOff(
  ctx: ExtensionContext,
  title: string,
  currentValue: boolean
): Promise<boolean | undefined> {
  const selection = await ctx.ui.select(title, [
    `${currentValue ? "✓ " : ""}On`,
    `${!currentValue ? "✓ " : ""}Off`,
    "Back",
  ]);

  if (!selection || selection === "Back") {
    return undefined;
  }

  return selection.endsWith("On");
}

async function editWaitTimeoutSetting(
  ctx: ExtensionContext,
  currentSeconds: number
): Promise<number | undefined> {
  const selection = await ctx.ui.select("Empty-queue wait timeout", [
    `Current: ${formatWaitTimeoutLabel(currentSeconds)}`,
    "0 seconds (wait indefinitely)",
    "30 seconds",
    "60 seconds",
    "300 seconds",
    "Custom value...",
    "Back",
  ]);

  if (!selection || selection === "Back" || selection.startsWith("Current:")) {
    return undefined;
  }

  if (selection === "Custom value...") {
    return promptForNonNegativeInt(ctx, "Custom wait timeout", "Seconds (0 or greater)");
  }

  return parseNonNegativeInt(selection.split(" ")[0] ?? "");
}

async function editWarningThresholdsSetting(
  ctx: ExtensionContext,
  currentMinutes: number,
  currentToolCalls: number
): Promise<{ minutes: number; toolCalls: number } | undefined> {
  const minutes = await promptForPositiveInt(
    ctx,
    "Warning threshold: minutes",
    `Current: ${currentMinutes}`
  );
  if (minutes === undefined) {
    return undefined;
  }

  const toolCalls = await promptForPositiveInt(
    ctx,
    "Warning threshold: tool calls",
    `Current: ${currentToolCalls}`
  );
  if (toolCalls === undefined) {
    return undefined;
  }

  return { minutes, toolCalls };
}

async function promptForPositiveInt(
  ctx: ExtensionContext,
  title: string,
  placeholder: string
): Promise<number | undefined> {
  while (true) {
    const response = await ctx.ui.input(title, placeholder);
    if (response === undefined) {
      return undefined;
    }

    const value = parsePositiveInt(response);
    if (value !== undefined) {
      return value;
    }

    notify(ctx, "Enter a whole number greater than 0.", "warning");
  }
}

async function promptForNonNegativeInt(
  ctx: ExtensionContext,
  title: string,
  placeholder: string
): Promise<number | undefined> {
  while (true) {
    const response = await ctx.ui.input(title, placeholder);
    if (response === undefined) {
      return undefined;
    }

    const value = parseNonNegativeInt(response);
    if (value !== undefined) {
      return value;
    }

    notify(ctx, "Enter a whole number 0 or greater.", "warning");
  }
}

async function editAutopilotPromptsSetting(
  ctx: ExtensionContext,
  state: QueueState,
  options: {
    onAutopilotPromptAdd: (prompt: string) => void;
    onAutopilotPromptsClear: () => void;
  }
): Promise<void> {
  const selection = await ctx.ui.select("Autopilot prompts", [
    `Current prompts: ${state.autopilotPrompts.length}`,
    "Add prompt",
    "Show prompts",
    "Clear prompts",
    "Back",
  ]);

  if (!selection || selection === "Back" || selection.startsWith("Current prompts:")) {
    return;
  }

  if (selection === "Add prompt") {
    const response = await ctx.ui.input("Add autopilot prompt", "Prompt text");
    const trimmed = response?.trim();
    if (trimmed) {
      options.onAutopilotPromptAdd(trimmed);
    }
    return;
  }

  if (selection === "Show prompts") {
    const lines =
      state.autopilotPrompts.length === 0
        ? ["Autopilot prompt list is empty."]
        : state.autopilotPrompts.map((item, index) => `${index + 1}. ${item}`);
    ctx.ui.notify(lines.join("\n"), "info");
    return;
  }

  if (selection === "Clear prompts") {
    const confirmed = await ctx.ui.confirm(
      "Clear autopilot prompts?",
      `Remove ${state.autopilotPrompts.length} prompt(s)?`
    );
    if (confirmed) {
      options.onAutopilotPromptsClear();
    }
  }
}

function formatWaitTimeoutLabel(seconds: number): string {
  return seconds === 0 ? "off" : `${seconds}s`;
}

function refreshConfiguration(): void {
  const settings = resolveCopilotQueueSettings();
  configuredProviders = settings.providers;
  showStatusLine = settings.showStatusLine;
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

interface StatusTheme {
  fg: (color: "accent" | "text" | "dim" | "warning", text: string) => string;
  bold: (text: string) => string;
}

function updateStatus(
  ctx: {
    hasUI: boolean;
    model: ExtensionContext["model"];
    ui: {
      setStatus: (key: string, text?: string) => void;
      theme?: StatusTheme;
    };
  },
  state: QueueState,
  waitingForQueue: boolean
): void {
  if (!ctx.hasUI) return;
  if (
    !showStatusLine ||
    !ctx.model?.provider ||
    !configuredProviders.includes(ctx.model.provider)
  ) {
    ctx.ui.setStatus(EXTENSION_COMMAND);
    return;
  }

  ctx.ui.setStatus(EXTENSION_COMMAND, formatStatusText(state, waitingForQueue, ctx.ui.theme));
}

function formatStatusText(
  state: QueueState,
  waitingForQueue: boolean,
  theme?: StatusTheme
): string {
  if (!theme) {
    const autopilot = state.autopilotEnabled
      ? `autopilot:${state.autopilotPrompts.length}`
      : "autopilot:off";
    const capture = state.captureInteractiveInput ? "capture:on" : "capture:off";
    const waiting = waitingForQueue ? " | waiting:input" : "";
    const misses = state.missedAskUserRunCount > 0 ? ` · miss:${state.missedAskUserRunCount}` : "";
    const session = `${formatElapsed(state)} · ${state.toolCallCount} tools${misses}`;
    return `${EXTENSION_NAME}: ${state.queue.length} queued${waiting} | ${autopilot} | ${capture} | ${session}`;
  }

  const separator = theme.fg("dim", " • ");
  const parts = [
    theme.fg("accent", theme.bold(EXTENSION_NAME)),
    `${theme.fg(state.queue.length > 0 ? "accent" : "text", String(state.queue.length))}${theme.fg("dim", " queued")}`,
    state.autopilotEnabled
      ? `${theme.fg("accent", String(state.autopilotPrompts.length))}${theme.fg("dim", " autopilot")}`
      : theme.fg("dim", "autopilot off"),
    theme.fg("dim", `capture ${state.captureInteractiveInput ? "on" : "off"}`),
    theme.fg("dim", `${formatElapsed(state)} • ${state.toolCallCount} tools`),
  ];

  if (waitingForQueue) {
    parts.splice(2, 0, theme.fg("warning", "waiting for input"));
  }

  if (state.missedAskUserRunCount > 0) {
    parts.push(theme.fg("warning", `miss ${state.missedAskUserRunCount}`));
  }

  return parts.join(separator);
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
