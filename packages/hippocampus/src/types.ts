export type TrainingExampleClass =
  | 'discovery'
  | 'conversation'
  | 'curated-memory'
  | 'session-memory'
  | 'recovery'
  | 'verification';

export interface TrainingPair {
  instruction: string;
  response: string;
  source: string;
  createdAt: number;
  instanceId?: string;
  sessionId?: string;
  exampleClass?: TrainingExampleClass;
}

export interface CurationResult {
  pairs: TrainingPair[];
  skipped: number;
  errors: string[];
}

export interface MemoryEntry {
  filename: string;
  content: string;
  date: string;
}

export interface SessionTurnEntry {
  sessionId: string;
  timestamp: string;
  user: string;
  assistant: string;
}
