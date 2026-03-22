import { EXTENSION_COMMAND } from "./constants.js";

export interface CommandCompletion {
  value: string;
  label: string;
}

export type QueueCommand =
  | { name: "add"; value: string }
  | { name: "list" }
  | { name: "clear" }
  | { name: "fallback"; value: string }
  | { name: "done" }
  | { name: "stop" }
  | { name: "capture"; mode: string }
  | { name: "providers"; value: string }
  | { name: "settings" }
  | { name: "autopilot-on" }
  | { name: "autopilot-off" }
  | { name: "autopilot-add"; value: string }
  | { name: "autopilot-list" }
  | { name: "autopilot-clear" }
  | { name: "session-reset" }
  | { name: "session-status" }
  | { name: "session-threshold"; minutes: string; toolCalls: string }
  | { name: "wait-timeout"; seconds: string }
  | { name: "help" };

const TOP_LEVEL_COMPLETIONS: CommandCompletion[] = [
  { value: "add ", label: "add <message> — queue a message" },
  { value: "list", label: "list — show queued messages" },
  { value: "clear", label: "clear — clear queued messages" },
  { value: "fallback ", label: "fallback <message> — set fallback response" },
  { value: "done", label: "done — release waiting ask_user with stop" },
  { value: "stop", label: "stop — stop next ask_user and disable autopilot" },
  { value: "capture on", label: "capture on — queue busy interactive input" },
  { value: "capture off", label: "capture off — keep normal steering while busy" },
  { value: "providers", label: "providers — show managed providers" },
  { value: "settings", label: "settings — open Copilot Queue settings" },
  { value: "autopilot on", label: "autopilot on — enable autopilot" },
  { value: "autopilot off", label: "autopilot off — disable autopilot" },
  { value: "autopilot add ", label: "autopilot add <message> — add autopilot prompt" },
  { value: "autopilot list", label: "autopilot list — show autopilot prompts" },
  { value: "autopilot clear", label: "autopilot clear — clear autopilot prompts" },
  { value: "session status", label: "session status — show session counters" },
  { value: "session reset", label: "session reset — reset session counters" },
  { value: "session threshold 120 50", label: "session threshold 120 50 — set warning thresholds" },
  { value: "wait-timeout 0", label: "wait-timeout 0 — wait indefinitely" },
  { value: "wait-timeout 60", label: "wait-timeout 60 — fallback after 60 seconds" },
  { value: "help", label: "help — show all commands" },
];

const FREEFORM_PREFIXES = ["add ", "fallback ", "autopilot add "];
const COMMON_PROVIDER_NAMES = [
  "github-copilot",
  "openai",
  "anthropic",
  "google",
  "openrouter",
  "ollama",
  "mistral",
  "groq",
];

export function buildHelpText(): string {
  return [
    `/${EXTENSION_COMMAND} add <message>`,
    `/${EXTENSION_COMMAND} list`,
    `/${EXTENSION_COMMAND} clear`,
    `/${EXTENSION_COMMAND} fallback <message>`,
    `/${EXTENSION_COMMAND} done`,
    `/${EXTENSION_COMMAND} stop`,
    `/${EXTENSION_COMMAND} capture <on|off>`,
    `/${EXTENSION_COMMAND} providers <name... | off>`,
    `/${EXTENSION_COMMAND} settings`,
    `/${EXTENSION_COMMAND} autopilot on`,
    `/${EXTENSION_COMMAND} autopilot off`,
    `/${EXTENSION_COMMAND} autopilot add <message>`,
    `/${EXTENSION_COMMAND} autopilot list`,
    `/${EXTENSION_COMMAND} autopilot clear`,
    `/${EXTENSION_COMMAND} session status`,
    `/${EXTENSION_COMMAND} session reset`,
    `/${EXTENSION_COMMAND} session threshold <minutes> <tool-calls>`,
    `/${EXTENSION_COMMAND} wait-timeout <seconds>`,
    `/${EXTENSION_COMMAND} help`,
  ].join("\n");
}

export function buildCommandArgumentCompletions(
  prefix: string,
  options?: { configuredProviders?: string[] }
): CommandCompletion[] | null {
  const trimmed = prefix.trimStart();

  if (FREEFORM_PREFIXES.some((item) => trimmed.startsWith(item))) {
    return null;
  }

  const completions = getCommandCompletions(trimmed, options?.configuredProviders ?? []);
  return completions.length > 0 ? completions : null;
}

export function parseCommand(raw: string): QueueCommand {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return { name: "help" };

  const firstSpace = trimmed.indexOf(" ");
  const command = (firstSpace === -1 ? trimmed : trimmed.slice(0, firstSpace)).toLowerCase();
  const rest = firstSpace === -1 ? "" : trimmed.slice(firstSpace + 1).trim();

  switch (command) {
    case "add":
      return { name: "add", value: rest };
    case "list":
      return { name: "list" };
    case "clear":
      return { name: "clear" };
    case "fallback":
      return { name: "fallback", value: rest };
    case "done":
      return { name: "done" };
    case "stop":
      return { name: "stop" };
    case "capture":
      return { name: "capture", mode: rest };
    case "providers":
      return { name: "providers", value: rest };
    case "settings":
      return { name: "settings" };
    case "autopilot":
      return parseAutopilot(rest);
    case "session":
      return parseSession(rest);
    case "wait-timeout":
      return { name: "wait-timeout", seconds: rest };
    default:
      return { name: "help" };
  }
}

function getCommandCompletions(prefix: string, configuredProviders: string[]): CommandCompletion[] {
  if (!prefix) {
    return TOP_LEVEL_COMPLETIONS;
  }

  const parts = prefix.split(/\s+/);
  const command = parts[0]?.toLowerCase() ?? "";

  if (parts.length === 1 && !prefix.endsWith(" ")) {
    return filterCompletions(TOP_LEVEL_COMPLETIONS, prefix);
  }

  switch (command) {
    case "capture":
      return filterCompletions(
        [
          { value: "capture on", label: "capture on — queue busy interactive input" },
          { value: "capture off", label: "capture off — keep normal steering while busy" },
        ],
        prefix
      );
    case "providers":
      return filterCompletions(buildProviderCompletions(configuredProviders), prefix);
    case "autopilot":
      return filterCompletions(
        [
          { value: "autopilot on", label: "autopilot on — enable autopilot" },
          { value: "autopilot off", label: "autopilot off — disable autopilot" },
          { value: "autopilot add ", label: "autopilot add <message> — add autopilot prompt" },
          { value: "autopilot list", label: "autopilot list — show autopilot prompts" },
          { value: "autopilot clear", label: "autopilot clear — clear autopilot prompts" },
        ],
        prefix
      );
    case "session":
      return filterCompletions(
        [
          { value: "session status", label: "session status — show session counters" },
          { value: "session reset", label: "session reset — reset session counters" },
          {
            value: "session threshold 120 50",
            label: "session threshold 120 50 — default warning thresholds",
          },
          {
            value: "session threshold 180 75",
            label: "session threshold 180 75 — longer sessions",
          },
        ],
        prefix
      );
    case "wait-timeout":
      return filterCompletions(
        [
          { value: "wait-timeout 0", label: "wait-timeout 0 — wait indefinitely" },
          { value: "wait-timeout 30", label: "wait-timeout 30 — fallback after 30 seconds" },
          { value: "wait-timeout 60", label: "wait-timeout 60 — fallback after 60 seconds" },
          { value: "wait-timeout 300", label: "wait-timeout 300 — fallback after 5 minutes" },
        ],
        prefix
      );
    default:
      return [];
  }
}

function buildProviderCompletions(configuredProviders: string[]): CommandCompletion[] {
  const providerNames = uniqueStrings([...configuredProviders, ...COMMON_PROVIDER_NAMES]);

  const providerSetExamples = providerNames.flatMap((provider) => [
    {
      value: `providers ${provider}`,
      label: `providers ${provider} — set global managed providers`,
    },
    {
      value: `providers set ${provider}`,
      label: `providers set ${provider} — set global managed providers`,
    },
    {
      value: `providers global ${provider}`,
      label: `providers global ${provider} — set global managed providers`,
    },
    {
      value: `providers global set ${provider}`,
      label: `providers global set ${provider} — set global managed providers`,
    },
  ]);

  return [
    { value: "providers", label: "providers — show managed providers" },
    { value: "providers show", label: "providers show — show managed providers" },
    { value: "providers list", label: "providers list — show managed providers" },
    { value: "providers status", label: "providers status — show managed providers" },
    { value: "providers off", label: "providers off — disable global provider routing" },
    { value: "providers clear", label: "providers clear — disable global provider routing" },
    { value: "providers set ", label: "providers set <name...> — set global managed providers" },
    { value: "providers global ", label: "providers global — global provider commands" },
    {
      value: "providers global off",
      label: "providers global off — disable global provider routing",
    },
    {
      value: "providers global set ",
      label: "providers global set <name...> — set global managed providers",
    },
    ...providerSetExamples,
  ];
}

function filterCompletions(completions: CommandCompletion[], prefix: string): CommandCompletion[] {
  return completions.filter((item) => item.value.startsWith(prefix));
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

function parseAutopilot(raw: string): QueueCommand {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return { name: "help" };

  const firstSpace = trimmed.indexOf(" ");
  const subcommand =
    firstSpace === -1 ? trimmed.toLowerCase() : trimmed.slice(0, firstSpace).toLowerCase();
  const rest = firstSpace === -1 ? "" : trimmed.slice(firstSpace + 1).trim();

  switch (subcommand) {
    case "on":
      return { name: "autopilot-on" };
    case "off":
      return { name: "autopilot-off" };
    case "add":
      return { name: "autopilot-add", value: rest };
    case "list":
      return { name: "autopilot-list" };
    case "clear":
      return { name: "autopilot-clear" };
    default:
      return { name: "help" };
  }
}

function parseSession(raw: string): QueueCommand {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return { name: "help" };

  const parts = trimmed.split(/\s+/);
  const subcommand = parts[0]?.toLowerCase();

  switch (subcommand) {
    case "reset":
      return { name: "session-reset" };
    case "status":
      return { name: "session-status" };
    case "threshold": {
      const minutes = parts[1] ?? "";
      const toolCalls = parts[2] ?? "";
      return { name: "session-threshold", minutes, toolCalls };
    }
    default:
      return { name: "help" };
  }
}
