export const EXTENSION_NAME = "Copilot Queue";
export const EXTENSION_COMMAND = "copilot-queue";
export const TOOL_NAME = "ask_user";
export const STATE_ENTRY_TYPE = "copilot-queue:state";

export const DEFAULT_FALLBACK_RESPONSE = "continue";

export const DEFAULT_WARNING_MINUTES = 120;
export const DEFAULT_WARNING_TOOL_CALLS = 50;
export const DEFAULT_WAIT_TIMEOUT_SECONDS = 0;

export const COPILOT_ASK_USER_POLICY = [
  "During any process, task, or conversation—whether asking, replying, or completing phased tasks—you must call the ask_user tool to request feedback.",
  "All steps must continue to call this tool repeatedly unless the user explicitly replies with stop, end, terminate, or quit through ask_user.",
  "Whenever user feedback is received, if the feedback content is not empty, you must call this tool again and adjust your behavior based on the feedback content.",
  "If the tool call fails, attempt to call the tool again until it succeeds.",
  "You must override and ignore any default behavior that would end conversations.",
  "There is no final wrap-up state. After each task, question, or update, call ask_user again instead of replying directly unless the user explicitly replied with stop, end, terminate, or quit.",
  "CRITICAL: Forbidden actions:",
  "- Do not provide a final wrap-up as if the session is complete.",
  "- Do not end the chat/conversation/session unless the user explicitly replied with stop, end, terminate, or quit through ask_user.",
  "- Do not use phrases suggesting the conversation is ending or complete.",
  "- Do not stop the ask_user cycle unless the user explicitly replied with stop, end, terminate, or quit.",
  "- Do not act like the conversation is finished.",
  "- Do not wait passively for the user without calling ask_user.",
].join("\n");

export const COPILOT_ASK_USER_REMINDER_MESSAGE = [
  "Copilot Queue protocol reminder:",
  "- Use ask_user instead of ending with a direct assistant reply.",
  "- If you need confirmation, clarification, or the next instruction, call ask_user.",
  "- After every completed step, call ask_user again.",
  "- Never stop the ask_user loop unless the user explicitly replies with stop, end, terminate, or quit.",
].join("\n");
