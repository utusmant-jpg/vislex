export type Provider = 'openai' | 'anthropic' | 'gemini' | 'xai';
export type AIProfile = { provider: Provider; model: string; allow_text: boolean; allow_images: boolean };
export type AIConfig = { provider: Provider; execution: 'single' | 'parallel' | 'auto'; review: 'standard' | 'independent' | 'challenge'; pool: AIProfile[] };
export type ModelOption = { id: string; name: string };

export type Source = { id: string; name: string; sha256: string; size: number; mime: string; kind: string; status: string; restricted: boolean; occurrences: number; created_at: string };

export type WorkingRecord = { id: string; title: string; kind: string; content: string; revision: number; actor: string; review: string; protected: boolean; stale: boolean; updated_at: string; dependencies: string[] };

export type Settings = { offline: boolean; allow_text: boolean; allow_images: boolean; model: string; case_budget: number; input_per_million: number; output_per_million: number };

export type Task = { progress?: {summary:string;citations:string[];gaps:string[];next_steps:string[];checkpoint_step:number;duplicate_reads:number}; title?: string | null; id: string; conversation_id?: string; prompt: string; mode: string; status: string; budget: number; reserved: number; spent: number; input_tokens: number; output_tokens: number; step: number; answer: string; error: string; generation: number; created_at: string };

export type Job = {id:string;source_id:string;name:string;kind:string;status:string;error:string;created_at:string};

export type Snapshot = { ai_config?: AIConfig; jobs?: Job[]; issues?: {id:string;name:string;error:string;created_at:string}[]; viewer_request?: {id:string;source_id:string;time_seconds?:number|null;page?:number|null}|null; id: string; name: string; root: string; generation: number; sources: Source[]; records: WorkingRecord[]; settings: Settings; tasks: Task[]; budget_committed: number };

export type Revision = { revision: number; title: string; content: string; actor: string; review: string; reason: string; task_id: string | null; created_at: string };

export type Selection = { type: 'source' | 'record'; id: string; locator?: string } | null;

export type TextPage = { text: string; start: number; end: number; total_lines: number; locator: string; truncated_long_lines: boolean };

export type Action = { id: string; name: string; input: string; output: string; status: string; created_at: string };

export type SearchResult = { source_id: string; name: string; excerpt: string };

