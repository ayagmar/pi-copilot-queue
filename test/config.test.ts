import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import {
  resolveConfiguredProviders,
  resolveShowStatusLine,
  writeGlobalConfiguredProviders,
  writeShowStatusLine,
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
    assert.deepEqual(resolveConfiguredProviders(homeDir), ["github-copilot"]);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
    rmSync(homeDir, { recursive: true, force: true });
  }
});

void test("resolveShowStatusLine defaults to true", () => {
  const cwd = createTempDir();
  const homeDir = createTempDir();

  try {
    assert.equal(resolveShowStatusLine(homeDir), true);
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

    assert.deepEqual(resolveConfiguredProviders(homeDir), ["github-copilot", "openai"]);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
    rmSync(homeDir, { recursive: true, force: true });
  }
});

void test("resolveConfiguredProviders ignores project settings", () => {
  const cwd = createTempDir();
  const homeDir = createTempDir();

  try {
    writeJson(join(cwd, ".pi", "settings.json"), {
      copilotQueue: {
        providers: ["anthropic"],
      },
    });

    assert.deepEqual(resolveConfiguredProviders(homeDir), ["github-copilot"]);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
    rmSync(homeDir, { recursive: true, force: true });
  }
});

void test("resolveConfiguredProviders supports global single-provider shorthand", () => {
  const cwd = createTempDir();
  const homeDir = createTempDir();

  try {
    writeJson(join(homeDir, ".pi", "agent", "settings.json"), {
      copilotQueue: {
        provider: "openai",
      },
    });

    assert.deepEqual(resolveConfiguredProviders(homeDir), ["openai"]);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
    rmSync(homeDir, { recursive: true, force: true });
  }
});

void test("resolveShowStatusLine reads global settings and ignores project overrides", () => {
  const cwd = createTempDir();
  const homeDir = createTempDir();

  try {
    writeJson(join(homeDir, ".pi", "agent", "settings.json"), {
      copilotQueue: {
        showStatusLine: true,
      },
    });
    writeJson(join(cwd, ".pi", "settings.json"), {
      copilotQueue: {
        showStatusLine: false,
      },
    });

    assert.equal(resolveShowStatusLine(homeDir), true);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
    rmSync(homeDir, { recursive: true, force: true });
  }
});

void test("resolveConfiguredProviders allows disabling with an empty global array", () => {
  const cwd = createTempDir();
  const homeDir = createTempDir();

  try {
    writeJson(join(homeDir, ".pi", "agent", "settings.json"), {
      copilotQueue: {
        providers: [],
      },
    });

    assert.deepEqual(resolveConfiguredProviders(homeDir), []);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
    rmSync(homeDir, { recursive: true, force: true });
  }
});

void test("writeGlobalConfiguredProviders writes global settings", () => {
  const cwd = createTempDir();
  const homeDir = createTempDir();

  try {
    const path = writeGlobalConfiguredProviders(["openai", "anthropic"], homeDir);

    assert.equal(path, join(homeDir, ".pi", "agent", "settings.json"));
    assert.deepEqual(resolveConfiguredProviders(homeDir), ["openai", "anthropic"]);

    const raw = readFileSync(path, "utf8");
    assert.match(raw, /"providers": \[\s+"openai",\s+"anthropic"\s+\]/s);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
    rmSync(homeDir, { recursive: true, force: true });
  }
});

void test("writeShowStatusLine preserves configured providers in global settings", () => {
  const cwd = createTempDir();
  const homeDir = createTempDir();

  try {
    writeJson(join(homeDir, ".pi", "agent", "settings.json"), {
      copilotQueue: {
        providers: ["github-copilot", "openai"],
      },
    });

    const path = writeShowStatusLine(false, homeDir);

    assert.equal(path, join(homeDir, ".pi", "agent", "settings.json"));
    assert.deepEqual(resolveConfiguredProviders(homeDir), ["github-copilot", "openai"]);
    assert.equal(resolveShowStatusLine(homeDir), false);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
    rmSync(homeDir, { recursive: true, force: true });
  }
});
