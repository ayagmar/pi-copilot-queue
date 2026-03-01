export interface QueueState {
  queue: string[];
  fallbackResponse: string;
  autopilotEnabled: boolean;
  autopilotPrompts: string[];
  autopilotIndex: number;
}
