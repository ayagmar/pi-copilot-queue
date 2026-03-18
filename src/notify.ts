/**
 * Terminal notification utilities extracted from pi-notify
 * Sends native terminal notifications when ask_user is waiting for input.
 */

import { execFile, spawn } from "node:child_process";

function windowsToastScript(title: string, body: string): string {
  const type = "Windows.UI.Notifications";
  const mgr = `[${type}.ToastNotificationManager, ${type}, ContentType = WindowsRuntime]`;
  const template = `[${type}.ToastTemplateType]::ToastText01`;
  const toast = `[${type}.ToastNotification]::new($xml)`;
  return [
    `${mgr} > $null`,
    `$xml = [${type}.ToastNotificationManager]::GetTemplateContent(${template})`,
    `$xml.GetElementsByTagName('text')[0].AppendChild($xml.CreateTextNode('${body}')) > $null`,
    `[${type}.ToastNotificationManager]::CreateToastNotifier('${title}').Show(${toast})`,
  ].join("; ");
}

function wrapForTmux(sequence: string): string {
  if (!process.env.TMUX) return sequence;

  // tmux passthrough: wrap in DCS and escape inner ESC bytes.
  const escaped = sequence.split("\x1b").join("\x1b\x1b");
  return `\x1bPtmux;${escaped}\x1b\\`;
}

function notifyOSC777(title: string, body: string): void {
  const sequence = `\x1b]777;notify;${title};${body}\x07`;
  process.stdout.write(wrapForTmux(sequence));
}

function notifyOSC9(message: string): void {
  const sequence = `\x1b]9;${message}\x07`;
  process.stdout.write(wrapForTmux(sequence));
}

function notifyOSC99(title: string, body: string): void {
  // Kitty OSC 99: i=notification id, d=0 means not done yet, p=body for second part
  const titleSequence = `\x1b]99;i=1:d=0;${title}\x1b\\`;
  const bodySequence = `\x1b]99;i=1:p=body;${body}\x1b\\`;
  process.stdout.write(wrapForTmux(titleSequence));
  process.stdout.write(wrapForTmux(bodySequence));
}

function notifyWindows(title: string, body: string): void {
  execFile("powershell.exe", ["-NoProfile", "-Command", windowsToastScript(title, body)]);
}

function runSoundHook(): void {
  const command = process.env.PI_NOTIFY_SOUND_CMD?.trim();
  if (!command) return;

  try {
    const child = spawn(command, {
      shell: true,
      detached: true,
      stdio: "ignore",
    });
    child.unref();
  } catch {
    // Ignore hook errors to avoid breaking notifications
  }
}

/**
 * Send a native terminal notification.
 * Supports multiple terminal protocols:
 * - OSC 777: Ghostty, WezTerm, rxvt-unicode
 * - OSC 9: iTerm2
 * - OSC 99: Kitty
 * - tmux passthrough wrapper for OSC notifications
 * - Windows toast: Windows Terminal (WSL)
 * - Optional sound hook via PI_NOTIFY_SOUND_CMD
 *
 * Safety: degrades to no-op in non-TTY or unsupported terminals to avoid
 * polluting logs, test output, or redirected streams with escape sequences.
 */
export function notifyTerminal(title: string, body: string): void {
  // Degrade gracefully in non-interactive environments (CI, tests, pipes)
  if (!process.stdout.isTTY) {
    return;
  }

  const isIterm2 =
    process.env.TERM_PROGRAM === "iTerm.app" || Boolean(process.env.ITERM_SESSION_ID);
  const isGhostty = process.env.TERM_PROGRAM === "ghostty";
  const isWezTerm = process.env.TERM_PROGRAM === "WezTerm";
  const isRxvt = typeof process.env.TERM === "string" && process.env.TERM.includes("rxvt-unicode");

  if (process.env.WT_SESSION) {
    notifyWindows(title, body);
  } else if (process.env.KITTY_WINDOW_ID) {
    notifyOSC99(title, body);
  } else if (isIterm2) {
    notifyOSC9(`${title}: ${body}`);
  } else if (isGhostty || isWezTerm || isRxvt) {
    notifyOSC777(title, body);
  }
  // Unsupported terminals: no-op (no fallback to avoid pollution)

  runSoundHook();
}
