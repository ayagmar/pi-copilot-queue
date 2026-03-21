import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export const DEFAULT_ACTIVE_PROVIDERS = ["github-copilot"] as const;

interface CopilotQueueSettings {
  providers?: unknown;
  provider?: unknown;
}

interface PiSettingsFile {
  copilotQueue?: CopilotQueueSettings;
}

export function resolveConfiguredProviders(cwd: string, homeDir: string = homedir()): string[] {
  const globalSettings = readSettingsFile(join(homeDir, ".pi", "agent", "settings.json"));
  const projectSettings = readSettingsFile(join(cwd, ".pi", "settings.json"));

  const projectProviders = readProviderOverride(projectSettings);
  if (projectProviders !== undefined) {
    return projectProviders;
  }

  const globalProviders = readProviderOverride(globalSettings);
  if (globalProviders !== undefined) {
    return globalProviders;
  }

  return [...DEFAULT_ACTIVE_PROVIDERS];
}

function readSettingsFile(path: string): PiSettingsFile | undefined {
  if (!existsSync(path)) {
    return undefined;
  }

  try {
    const raw = readFileSync(path, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object") {
      return undefined;
    }
    return parsed as PiSettingsFile;
  } catch {
    return undefined;
  }
}

function readProviderOverride(settings: PiSettingsFile | undefined): string[] | undefined {
  const config = settings?.copilotQueue;
  if (!config || typeof config !== "object") {
    return undefined;
  }

  const providers = normalizeProviders(config.providers);
  if (providers !== undefined) {
    return providers;
  }

  const provider = normalizeProvider(config.provider);
  if (provider !== undefined) {
    return [provider];
  }

  return undefined;
}

export function writeConfiguredProviders(
  cwd: string,
  providers: string[],
  scope: "project" | "global" = "project",
  homeDir: string = homedir()
): string {
  const path =
    scope === "global"
      ? join(homeDir, ".pi", "agent", "settings.json")
      : join(cwd, ".pi", "settings.json");
  const existing = readSettingsFile(path);
  const nextProviders = normalizeProviders(providers) ?? [];
  const nextQueue: CopilotQueueSettings =
    existing?.copilotQueue && typeof existing.copilotQueue === "object"
      ? { ...existing.copilotQueue }
      : {};

  delete nextQueue.provider;
  nextQueue.providers = nextProviders;

  const nextSettings: PiSettingsFile = existing ? { ...existing } : {};
  nextSettings.copilotQueue = nextQueue;

  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(nextSettings, null, 2)}\n`, "utf8");
  return path;
}

export function writeProjectConfiguredProviders(cwd: string, providers: string[]): string {
  return writeConfiguredProviders(cwd, providers, "project");
}

export function writeGlobalConfiguredProviders(
  cwd: string,
  providers: string[],
  homeDir: string = homedir()
): string {
  return writeConfiguredProviders(cwd, providers, "global", homeDir);
}

function normalizeProviders(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }

  const providers = value
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter(Boolean);

  return [...new Set(providers)];
}

function normalizeProvider(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const trimmed = value.trim();
  if (!trimmed) {
    return undefined;
  }

  return trimmed;
}
