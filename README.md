# Copilot Queue (Pi Extension)

Queue user feedback ahead of time and let the model consume it via an `ask_user` tool.

This extension is inspired by [TaskSync](https://github.com/4regab/TaskSync)-style workflows: you preload responses, then configured providers can pull them during long runs.

## What it does

- Registers tool: `ask_user`
- Registers command: `/copilot-queue`
- Keeps a FIFO queue of responses
- Supports autopilot prompt cycling (1→2→3→1…)
- Activates queue/autopilot only on configured providers (defaults to `github-copilot`)
- Injects a provider-targeted `ask_user` loop policy into the system prompt on each new run
- While a configured provider is actively running, normal interactive input is captured into queue by default (instead of triggering a new turn)
- Interactive capture can be toggled with `/copilot-queue capture on|off` (`on` by default)
- Tracks session elapsed time, tool-call count, and direct-reply misses in status line
- Emits session hygiene warnings at configurable thresholds (default: 120 minutes, 50 tool calls)
- Persists state in session entries
- Shows queue/autopilot/session state in Pi status line when the current provider is configured for Copilot Queue

When `ask_user` is called:

1. If queue has items → returns next queued response
2. Else if autopilot is enabled and has prompts → returns next autopilot prompt (cycling)
3. Else in interactive UI for a configured provider → waits for `/copilot-queue add <message>`, `/copilot-queue done`, or `/copilot-queue stop` (optionally with timeout)
4. Else → returns fallback response (`continue` by default)

When the current model provider is not configured for Copilot Queue, queue/autopilot is bypassed, `ask_user` uses manual/fallback behavior only, and the extension status line is hidden.

## Install

### Option 1: Direct with Pi (npm or git)

Install from npm:

```bash
pi install npm:pi-copilot-queue
```

Install from git:

```bash
pi install git:github.com/ayagmar/pi-copilot-queue
```

Pinned to a specific release tag:

```bash
pi install git:github.com/ayagmar/pi-copilot-queue@v0.1.1
```

Project-local install (writes to `.pi/settings.json`):

```bash
pi install -l git:github.com/ayagmar/pi-copilot-queue
```

Install from local path:

```bash
pi install /absolute/path/to/pi-copilot-queue
```

Then reload in Pi:

```text
/reload
```

### Option 2: With [pi-extmgr](https://github.com/ayagmar/pi-extmgr) (`/extensions`)

Install extmgr once:

```bash
pi install npm:pi-extmgr
```

Then in Pi (GitHub source):

```text
/extensions install git:github.com/ayagmar/pi-copilot-queue
/reload
```

Or install the extension file directly from GitHub (`index.ts`/entrypoint path):

```text
/extensions install https://github.com/ayagmar/pi-copilot-queue/blob/master/src/index.ts
/reload
```

You can also install a local extension file directly:

```text
/extensions install /absolute/path/to/pi-copilot-queue/src/index.ts
/reload
```

## Settings

By default, Copilot Queue is active only for `github-copilot`.

You can override that in Pi settings:

```json
{
  "copilotQueue": {
    "providers": ["github-copilot", "openai"]
  }
}
```

Single-provider shorthand also works:

```json
{
  "copilotQueue": {
    "provider": "github-copilot"
  }
}
```

Settings lookup order:

- `.pi/settings.json` overrides
- `~/.pi/agent/settings.json`
- default: `["github-copilot"]`

Use an empty array to disable provider interception entirely:

```json
{
  "copilotQueue": {
    "providers": []
  }
}
```

You can also manage the project or global override from inside Pi:

```text
/copilot-queue providers
/copilot-queue providers github-copilot openai
/copilot-queue providers global openai anthropic
/copilot-queue providers off
/copilot-queue providers global off
```

- `providers` with no arguments shows the current active list.
- Passing one or more provider names writes `.pi/settings.json` for the current project.
- Prefixing with `global` writes `~/.pi/agent/settings.json` instead.
- `off` writes an empty provider list for the selected scope.
- Tab completion suggests the provider subcommands (`global`, `project`, `off`, `show`, `list`, `status`, `set`).

## Usage

### Queue messages

```text
/copilot-queue add continue with the refactor
/copilot-queue add now add tests for edge cases
/copilot-queue list
/copilot-queue clear
/copilot-queue done
/copilot-queue stop
```

### Done / stop waiting

```text
/copilot-queue done
/copilot-queue stop
```

Both commands request an explicit stop. If `ask_user` is currently waiting, it is released with `stop`. Otherwise the next `ask_user` call will immediately receive `stop`.

### Interactive capture while busy (configured providers only)

```text
/copilot-queue capture on
/copilot-queue capture off
```

- `on` (default): while a run is active, interactive input is queued for `ask_user`.
- `off`: keep normal steering behavior (input is not auto-queued).

### Wait timeout (for empty queue in UI mode)

```text
/copilot-queue wait-timeout 0
/copilot-queue wait-timeout 60
```

- `0` disables timeout (default): wait indefinitely.
- `>0` makes waiting `ask_user` return fallback after `<seconds>`.

### Session counters and hygiene warnings

```text
/copilot-queue session status
/copilot-queue session reset
/copilot-queue session threshold 120 50
```

- Status line always includes elapsed time + tool-call count, and shows missed ask_user runs when they happen.
- `/copilot-queue session status` also reports completed managed-provider runs, runs that used `ask_user`, direct replies that skipped `ask_user`, compliance rate, and the last missed direct reply preview.
- Warnings are advisory only (no forced stop).
- Default thresholds are `120` minutes and `50` tool calls.

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
When provider is managed by Copilot Queue, use the ask_user tool whenever feedback is required. Keep calling ask_user after every completed step instead of ending with a direct reply. Only stop when the user explicitly replies with stop, end, terminate, or quit.
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
