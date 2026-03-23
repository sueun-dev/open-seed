import {
  createRunRecord,
  summarizeRuns,
  type CreateRunRecordInput,
  type RunRecord,
  type RunSummary,
} from './schema.js';

export interface RunRepository {
  listRuns(): readonly RunRecord[];
  createRun(input: CreateRunRecordInput): RunRecord;
  getSummary(): RunSummary;
  clear(): void;
}

class InMemoryRunRepository implements RunRepository {
  private readonly records: RunRecord[] = [];
  private sequence = 0;

  listRuns(): readonly RunRecord[] {
    return [...this.records];
  }

  createRun(input: CreateRunRecordInput): RunRecord {
    this.sequence += 1;
    const record = createRunRecord(input, this.sequence);
    this.records.push(record);
    return record;
  }

  getSummary(): RunSummary {
    return summarizeRuns(this.records);
  }

  clear(): void {
    this.records.length = 0;
    this.sequence = 0;
  }
}

let repository: RunRepository | null = null;

export function getRunRepository(): RunRepository {
  if (!repository) {
    repository = new InMemoryRunRepository();
  }

  return repository;
}

export function resetRunRepository(): void {
  repository = new InMemoryRunRepository();
}
