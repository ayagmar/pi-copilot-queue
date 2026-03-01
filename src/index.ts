import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import {
  DEFAULT_FALLBACK_RESPONSE,
  EXTENSION_COMMAND,
  EXTENSION_NAME,
  STATE_ENTRY_TYPE,
  TOOL_NAME,
} from "./constants.js";
import { buildHelpText, parseCommand } from "./commands.js";
import type { QueueState } from "./types.js";

export default function copilotQueueExtension(pi: ExtensionAPI) {
  let state: QueueState = initialState();

  function syncState(ctx: Pick<ExtensionContext, "sessionManager" | "hasUI" | "ui">): void {
    state = restoreFromContext(ctx);
    updateStatus(ctx, state);
  }

  pi.on("session_start", (_event, ctx) => syncState(ctx));
  pi.on("session_switch", (_event, ctx) => syncState(ctx));
  pi.on("session_tree", (_event, ctx) => syncState(ctx));
  pi.on("session_fork", (_event, ctx) => syncState(ctx));

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
          state = { ...state, queue: [...state.queue, command.value] };
          persistState(pi, state);
          updateStatus(ctx, state);
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
          updateStatus(ctx, state);
          notify(ctx, "Queue cleared.");
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
          updateStatus(ctx, state);
          notify(ctx, "Autopilot enabled.");
          return Promise.resolve();
        }

        case "autopilot-off": {
          state = { ...state, autopilotEnabled: false };
          persistState(pi, state);
          updateStatus(ctx, state);
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
          updateStatus(ctx, state);
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
          updateStatus(ctx, state);
          notify(ctx, "Autopilot prompts cleared.");
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
      "Returns the next queued response first. If queue is empty, uses autopilot prompts in cycle mode. If no autopilot prompt is available, asks the user in UI mode or returns fallback response.",
    parameters: Type.Object({
      prompt: Type.Optional(
        Type.String({ description: "Question to display when queue and autopilot are empty" })
      ),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const queued = state.queue[0];
      if (queued) {
        state = { ...state, queue: state.queue.slice(1) };
        persistState(pi, state);
        updateStatus(ctx, state);
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
        updateStatus(ctx, state);
        return {
          content: [{ type: "text", text }],
          details: { source: "autopilot", remaining: 0 },
        };
      }

      if (ctx.hasUI) {
        const prompt =
          params.prompt?.trim() ||
          "Agent asked for feedback. Your response (blank = fallback response):";
        const response = await ctx.ui.input("Copilot Queue", prompt);
        const text = response?.trim() || state.fallbackResponse;
        return {
          content: [{ type: "text", text }],
          details: { source: response?.trim() ? "manual" : "fallback", remaining: 0 },
        };
      }

      return {
        content: [{ type: "text", text: state.fallbackResponse }],
        details: { source: "fallback", remaining: 0 },
      };
    },
  });
}

function initialState(): QueueState {
  return {
    queue: [],
    fallbackResponse: DEFAULT_FALLBACK_RESPONSE,
    autopilotEnabled: false,
    autopilotPrompts: [],
    autopilotIndex: 0,
  };
}

function persistState(pi: ExtensionAPI, state: QueueState): void {
  pi.appendEntry(STATE_ENTRY_TYPE, state);
}

function updateStatus(
  ctx: { hasUI: boolean; ui: { setStatus: (key: string, text?: string) => void } },
  state: QueueState
): void {
  if (!ctx.hasUI) return;
  const autopilot = state.autopilotEnabled
    ? `autopilot:${state.autopilotPrompts.length}`
    : "autopilot:off";
  ctx.ui.setStatus(
    EXTENSION_COMMAND,
    `${EXTENSION_NAME}: ${state.queue.length} queued | ${autopilot}`
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
    autopilotEnabled?: unknown;
    autopilotPrompts?: unknown;
    autopilotIndex?: unknown;
  };

  if (
    !Array.isArray(candidate.queue) ||
    !candidate.queue.every((item) => typeof item === "string")
  ) {
    return undefined;
  }

  if (typeof candidate.fallbackResponse !== "string") return undefined;

  const autopilotPrompts = Array.isArray(candidate.autopilotPrompts)
    ? candidate.autopilotPrompts.filter((item): item is string => typeof item === "string")
    : [];

  const autopilotEnabled =
    typeof candidate.autopilotEnabled === "boolean" ? candidate.autopilotEnabled : false;
  const rawIndex = typeof candidate.autopilotIndex === "number" ? candidate.autopilotIndex : 0;
  const autopilotIndex = Number.isInteger(rawIndex) && rawIndex >= 0 ? rawIndex : 0;

  return {
    queue: candidate.queue,
    fallbackResponse: candidate.fallbackResponse,
    autopilotEnabled,
    autopilotPrompts,
    autopilotIndex,
  };
}

function notify(
  ctx: { hasUI: boolean; ui: { notify: (message: string, level: "info") => void } },
  message: string
): void {
  if (ctx.hasUI) {
    ctx.ui.notify(message, "info");
  } else {
    console.log(message);
  }
}
