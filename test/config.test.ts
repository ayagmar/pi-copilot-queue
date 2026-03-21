import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import {
  resolveConfiguredProviders,
  writeGlobalConfiguredProviders,
  writeProjectConfiguredProviders,
} from "../src/config.js";

function createTempDir(): string {
  return mkdtempSync(join(tmpdir(), "pi-copilot-queue-"));
}

function writeJson(path: string, data: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(data, null, 2));
}

void test("resolveConfiguredProviders defaults to github-copilot", () => {
  const cwd = createTempDir();
  const homeDir = createTempDir();

  try {
    assert.deepEqual(resolveConfiguredProviders(cwd, homeDir), ["github-copilot"]);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
    rmSync(homeDir, { recursive: true, force: true });
  }
});

void test("resolveConfiguredProviders reads global settings", () => {
  const cwd = createTempDir();
  const homeDir = createTempDir();

  try {
    writeJson(join(homeDir, ".pi", "agent", "settings.json"), {
      copilotQueue: {
        providers: ["github-copilot", "openai"],
      },
    });

    assert.deepEqual(resolveConfiguredProviders(cwd, homeDir), ["github-copilot", "openai"]);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
    rmSync(homeDir, { recursive: true, force: true });
  }
});

void test("resolveConfiguredProviders lets project settings override global settings", () => {
  const cwd = createTempDir();
  const homeDir = createTempDir();

  try {
    writeJson(join(homeDir, ".pi", "agent", "settings.json"), {
      copilotQueue: {
        providers: ["github-copilot", "openai"],
      },
    });
    writeJson(join(cwd, ".pi", "settings.json"), {
      copilotQueue: {
        providers: ["anthropic"],
      },
    });

    assert.deepEqual(resolveConfiguredProviders(cwd, homeDir), ["anthropic"]);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
    rmSync(homeDir, { recursive: true, force: true });
  }
});

void test("resolveConfiguredProviders supports single-provider shorthand", () => {
  const cwd = createTempDir();
  const homeDir = createTempDir();

  try {
    writeJson(join(cwd, ".pi", "settings.json"), {
      copilotQueue: {
        provider: "openai",
      },
    });

    assert.deepEqual(resolveConfiguredProviders(cwd, homeDir), ["openai"]);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
    rmSync(homeDir, { recursive: true, force: true });
  }
});

void test("resolveConfiguredProviders allows disabling with an empty array", () => {
  const cwd = createTempDir();
  const homeDir = createTempDir();

  try {
    writeJson(join(cwd, ".pi", "settings.json"), {
      copilotQueue: {
        providers: [],
      },
    });

    assert.deepEqual(resolveConfiguredProviders(cwd, homeDir), []);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
    rmSync(homeDir, { recursive: true, force: true });
  }
});

void test("writeProjectConfiguredProviders writes project settings", () => {
  const cwd = createTempDir();

  try {
    const path = writeProjectConfiguredProviders(cwd, ["github-copilot", "openai"]);

    assert.equal(path, join(cwd, ".pi", "settings.json"));
    assert.deepEqual(resolveConfiguredProviders(cwd, cwd), ["github-copilot", "openai"]);

    const raw = readFileSync(path, "utf8");
    assert.match(raw, /"providers": \[\s+"github-copilot",\s+"openai"\s+\]/s);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

void test("writeGlobalConfiguredProviders writes global settings", () => {
  const cwd = createTempDir();
  const homeDir = createTempDir();

  try {
    const path = writeGlobalConfiguredProviders(cwd, ["openai", "anthropic"], homeDir);

    assert.equal(path, join(homeDir, ".pi", "agent", "settings.json"));
    assert.deepEqual(resolveConfiguredProviders(cwd, homeDir), ["openai", "anthropic"]);

    const raw = readFileSync(path, "utf8");
    assert.match(raw, /"providers": \[\s+"openai",\s+"anthropic"\s+\]/s);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
    rmSync(homeDir, { recursive: true, force: true });
  }
});
