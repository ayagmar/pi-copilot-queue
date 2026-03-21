export interface QueueState {
  queue: string[];
  fallbackResponse: string;
  captureInteractiveInput: boolean;
  stopRequested: boolean;
  autopilotEnabled: boolean;
  autopilotPrompts: string[];
  autopilotIndex: number;
  sessionStartedAt: number;
  toolCallCount: number;
  completedRunCount: number;
  askUserRunCount: number;
  missedAskUserRunCount: number;
  lastMissedAssistantReply: string;
  warningMinutes: number;
  warningToolCalls: number;
  waitTimeoutSeconds: number;
  warnedTime: boolean;
  warnedToolCalls: boolean;
}
