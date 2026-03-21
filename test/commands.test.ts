import assert from "node:assert/strict";
import test from "node:test";
import { buildHelpText, parseCommand } from "../src/commands.js";

void test("parseCommand parses add", () => {
  assert.deepEqual(parseCommand("add hello world"), { name: "add", value: "hello world" });
});

void test("parseCommand parses autopilot add", () => {
  assert.deepEqual(parseCommand("autopilot add continue with tests"), {
    name: "autopilot-add",
    value: "continue with tests",
  });
});

void test("parseCommand parses autopilot on", () => {
  assert.deepEqual(parseCommand("autopilot on"), { name: "autopilot-on" });
});

void test("parseCommand parses done", () => {
  assert.deepEqual(parseCommand("done"), { name: "done" });
});

void test("parseCommand parses stop", () => {
  assert.deepEqual(parseCommand("stop"), { name: "stop" });
});

void test("parseCommand parses capture", () => {
  assert.deepEqual(parseCommand("capture off"), { name: "capture", mode: "off" });
});

void test("parseCommand parses providers", () => {
  assert.deepEqual(parseCommand("providers github-copilot openai"), {
    name: "providers",
    value: "github-copilot openai",
  });
});

void test("parseCommand parses session status", () => {
  assert.deepEqual(parseCommand("session status"), { name: "session-status" });
});

void test("parseCommand parses session reset", () => {
  assert.deepEqual(parseCommand("session reset"), { name: "session-reset" });
});

void test("parseCommand parses session threshold", () => {
  assert.deepEqual(parseCommand("session threshold 180 75"), {
    name: "session-threshold",
    minutes: "180",
    toolCalls: "75",
  });
});

void test("parseCommand parses wait-timeout", () => {
  assert.deepEqual(parseCommand("wait-timeout 45"), {
    name: "wait-timeout",
    seconds: "45",
  });
});

void test("parseCommand returns help for unknown", () => {
  assert.deepEqual(parseCommand("wat"), { name: "help" });
});

void test("help includes key commands", () => {
  const help = buildHelpText();
  assert.match(help, /copilot-queue add/);
  assert.match(help, /copilot-queue clear/);
  assert.match(help, /copilot-queue done/);
  assert.match(help, /copilot-queue stop/);
  assert.match(help, /copilot-queue capture/);
  assert.match(help, /copilot-queue providers/);
  assert.match(help, /copilot-queue autopilot on/);
  assert.match(help, /copilot-queue session reset/);
  assert.match(help, /copilot-queue wait-timeout/);
});
