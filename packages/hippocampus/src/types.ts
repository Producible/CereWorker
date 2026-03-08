export interface TrainingPair {
  instruction: string;
  response: string;
  source: string;
  createdAt: number;
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
