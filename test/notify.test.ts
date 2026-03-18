import assert from "node:assert/strict";
import test from "node:test";
import { notifyTerminal } from "../src/notify.js";

interface Capture {
  writes: string[];
  originalWrite: typeof process.stdout.write;
  originalIsTTY: boolean | undefined;
  envSnapshot: NodeJS.ProcessEnv;
}

function captureStdout(): Capture {
  const writes: string[] = [];
  const originalWrite = process.stdout.write.bind(process.stdout);
  const originalIsTTY = process.stdout.isTTY;

  // Mock stdout.write to capture output
  process.stdout.write = ((
    chunk: string | Uint8Array,
    _encodingOrCb?: BufferEncoding | ((err?: Error) => void),
    _cb?: (err?: Error) => void
  ): boolean => {
    const str = typeof chunk === "string" ? chunk : Buffer.from(chunk).toString();
    writes.push(str);
    return true;
  }) as typeof process.stdout.write;

  // Snapshot environment variables
  const envSnapshot = { ...process.env };

  return { writes, originalWrite, originalIsTTY, envSnapshot };
}

function restoreStdout(capture: Capture): void {
  process.stdout.write = capture.originalWrite;
  (process.stdout as { isTTY: boolean | undefined }).isTTY = capture.originalIsTTY;

  // Restore environment variables
  for (const key of Object.keys(process.env)) {
    delete process.env[key];
  }
  Object.assign(process.env, capture.envSnapshot);
}

function clearEnvVars(): void {
  const varsToClear = [
    "WT_SESSION",
    "KITTY_WINDOW_ID",
    "TERM_PROGRAM",
    "ITERM_SESSION_ID",
    "TERM",
    "TMUX",
  ];
  for (const v of varsToClear) {
    delete process.env[v];
  }
}

void test("notifyTerminal does nothing when stdout is not a TTY", () => {
  const capture = captureStdout();
  (process.stdout as { isTTY?: boolean }).isTTY = false;
  clearEnvVars();

  try {
    notifyTerminal("Test Title", "Test Body");
    assert.deepEqual(capture.writes, [], "Should not write anything when isTTY is false");
  } finally {
    restoreStdout(capture);
  }
});

void test("notifyTerminal does nothing for unsupported terminals", () => {
  const capture = captureStdout();
  (process.stdout as { isTTY?: boolean }).isTTY = true;
  clearEnvVars();

  // Set TERM to a generic value that doesn't indicate a supported terminal
  process.env.TERM = "xterm-256color";

  try {
    notifyTerminal("Test Title", "Test Body");
    assert.deepEqual(capture.writes, [], "Should not write anything for unsupported terminals");
  } finally {
    restoreStdout(capture);
  }
});

void test("notifyTerminal emits OSC 777 for Ghostty", () => {
  const capture = captureStdout();
  (process.stdout as { isTTY?: boolean }).isTTY = true;
  clearEnvVars();

  process.env.TERM_PROGRAM = "ghostty";

  try {
    notifyTerminal("Hello", "World");
    assert.equal(capture.writes.length, 1, "Should write one sequence");
    assert.ok(
      capture.writes[0]?.includes("\x1b]777;notify;Hello;World\x07"),
      "Should emit OSC 777 sequence"
    );
  } finally {
    restoreStdout(capture);
  }
});

void test("notifyTerminal emits OSC 777 for WezTerm", () => {
  const capture = captureStdout();
  (process.stdout as { isTTY?: boolean }).isTTY = true;
  clearEnvVars();

  process.env.TERM_PROGRAM = "WezTerm";

  try {
    notifyTerminal("Title", "Body");
    assert.equal(capture.writes.length, 1, "Should write one sequence");
    assert.ok(
      capture.writes[0]?.includes("\x1b]777;notify;Title;Body\x07"),
      "Should emit OSC 777 sequence"
    );
  } finally {
    restoreStdout(capture);
  }
});

void test("notifyTerminal emits OSC 777 for rxvt-unicode", () => {
  const capture = captureStdout();
  (process.stdout as { isTTY?: boolean }).isTTY = true;
  clearEnvVars();

  process.env.TERM = "rxvt-unicode-256color";

  try {
    notifyTerminal("Alert", "Message");
    assert.equal(capture.writes.length, 1, "Should write one sequence");
    assert.ok(
      capture.writes[0]?.includes("\x1b]777;notify;Alert;Message\x07"),
      "Should emit OSC 777 sequence"
    );
  } finally {
    restoreStdout(capture);
  }
});

void test("notifyTerminal emits OSC 99 for Kitty", () => {
  const capture = captureStdout();
  (process.stdout as { isTTY?: boolean }).isTTY = true;
  clearEnvVars();

  process.env.KITTY_WINDOW_ID = "1";

  try {
    notifyTerminal("Kitty", "Test");
    assert.equal(capture.writes.length, 2, "Should write title and body sequences");
    const combined = capture.writes.join("");
    assert.ok(
      combined.includes("\x1b]99;i=1:d=0;Kitty\x1b\\"),
      "Should emit OSC 99 title sequence"
    );
    assert.ok(
      combined.includes("\x1b]99;i=1:p=body;Test\x1b\\"),
      "Should emit OSC 99 body sequence"
    );
  } finally {
    restoreStdout(capture);
  }
});

void test("notifyTerminal emits OSC 9 for iTerm2 (TERM_PROGRAM)", () => {
  const capture = captureStdout();
  (process.stdout as { isTTY?: boolean }).isTTY = true;
  clearEnvVars();

  process.env.TERM_PROGRAM = "iTerm.app";

  try {
    notifyTerminal("iTerm", "Notification");
    assert.equal(capture.writes.length, 1, "Should write one sequence");
    assert.ok(
      capture.writes[0]?.includes("\x1b]9;iTerm: Notification\x07"),
      "Should emit OSC 9 sequence"
    );
  } finally {
    restoreStdout(capture);
  }
});

void test("notifyTerminal emits OSC 9 for iTerm2 (ITERM_SESSION_ID)", () => {
  const capture = captureStdout();
  (process.stdout as { isTTY?: boolean }).isTTY = true;
  clearEnvVars();

  process.env.ITERM_SESSION_ID = "w0t0p0:12345";

  try {
    notifyTerminal("iTerm", "Notification");
    assert.equal(capture.writes.length, 1, "Should write one sequence");
    assert.ok(
      capture.writes[0]?.includes("\x1b]9;iTerm: Notification\x07"),
      "Should emit OSC 9 sequence"
    );
  } finally {
    restoreStdout(capture);
  }
});

void test("notifyTerminal wraps for tmux when detected", () => {
  const capture = captureStdout();
  (process.stdout as { isTTY?: boolean }).isTTY = true;
  clearEnvVars();

  process.env.TERM_PROGRAM = "ghostty";
  process.env.TMUX = "/tmp/tmux-1000/default,1234,0";

  try {
    notifyTerminal("Tmux", "Test");
    assert.equal(capture.writes.length, 1, "Should write one sequence");
    const output = capture.writes[0] ?? "";
    // tmux passthrough wraps in DCS sequence
    assert.ok(output.startsWith("\x1bPtmux;"), "Should start with tmux DCS");
    assert.ok(output.includes("\x1b\x1b]777;notify;Tmux;Test\x07"), "Should have escaped OSC");
    assert.ok(output.endsWith("\x1b\\"), "Should end with ST");
  } finally {
    restoreStdout(capture);
  }
});

void test("notifyTerminal is safe when isTTY is undefined", () => {
  const capture = captureStdout();
  // In some environments isTTY might be undefined rather than false
  (process.stdout as { isTTY: boolean | undefined }).isTTY = undefined;
  clearEnvVars();

  try {
    notifyTerminal("Test", "Body");
    assert.deepEqual(capture.writes, [], "Should not write when isTTY is undefined");
  } finally {
    restoreStdout(capture);
  }
});
