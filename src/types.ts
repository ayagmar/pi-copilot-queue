export interface QueueState {
  queue: string[];
  fallbackResponse: string;
  captureInteractiveInput: boolean;
  autopilotEnabled: boolean;
  autopilotPrompts: string[];
  autopilotIndex: number;
  sessionStartedAt: number;
  toolCallCount: number;
  warningMinutes: number;
  warningToolCalls: number;
  waitTimeoutSeconds: number;
  warnedTime: boolean;
  warnedToolCalls: boolean;
}
