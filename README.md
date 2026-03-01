# Copilot Queue (Pi Extension)

Queue user feedback ahead of time and let the model consume it via an `ask_user` tool.

This extension is inspired by TaskSync-style workflows: you preload responses, then your Copilot-like agent pulls them during long runs.

## What it does

- Registers tool: `ask_user`
- Registers command: `/copilot-queue`
- Keeps a FIFO queue of responses
- Supports autopilot prompt cycling (1→2→3→1…)
- Persists state in session entries
- Shows queue/autopilot state in Pi status line

When `ask_user` is called:

1. If queue has items → returns next queued response
2. Else if autopilot is enabled and has prompts → returns next autopilot prompt (cycling)
3. Else in interactive UI → asks you for manual input
4. Else → returns fallback response (`continue` by default)

## Install

```bash
pi install /absolute/path/to/pi-copilot-queue
```

Then reload in Pi:

```text
/reload
```

## Usage

### Queue messages

```text
/copilot-queue add continue with the refactor
/copilot-queue add now add tests for edge cases
/copilot-queue list
/copilot-queue clear
```

### Fallback message

```text
/copilot-queue fallback continue
```

### Autopilot (cycling prompts)

```text
/copilot-queue autopilot add continue with implementation
/copilot-queue autopilot add now write tests
/copilot-queue autopilot on
/copilot-queue autopilot list
/copilot-queue autopilot off
/copilot-queue autopilot clear
```

## Recommended instruction snippet for your model

```text
Use the ask_user tool whenever feedback is required. Keep calling ask_user for iterative feedback unless the user explicitly says to stop.
```

## Development

```bash
pnpm install
pnpm run check
```

Quick run:

```bash
pi -e ./src/index.ts
```
