export interface PipelineEvent {
  type: string;
  node: string;
  data: Record<string, any>;
  timestamp?: string;
}
