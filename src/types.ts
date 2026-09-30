export type Provider = 'openai' | 'anthropic' | 'gemini' | 'xai' | 'openrouter';
export type AIProfile = { provider: Provider; model: string; allow_text: boolean; allow_images: boolean };
export type AIConfig = { provider: Provider; execution: 'single' | 'parallel' | 'auto'; review: 'standard' | 'independent' | 'challenge'; pool: AIProfile[] };
export type ModelOption = { id: string; name: string; /** Published catalogue facts (OpenRouter); absent means unknown. */ input_modalities?: string[]; context_length?: number; prompt_price?: string; completion_price?: string };

export type Source = { id: string; name: string; sha256: string; size: number; mime: string; kind: string; status: string; restricted: boolean; occurrences: number; created_at: string };

export type WorkingRecord = { id: string; title: string; kind: string; content: string; revision: number; actor: string; review: string; protected: boolean; stale: boolean; updated_at: string; dependencies: string[] };
export type RecordSummary = Omit<WorkingRecord, 'content'>;

export type Settings = { offline: boolean; allow_text: boolean; allow_images: boolean; model: string };

export type Task = { updated_at?: string; progress?: {summary:string;citations:string[];gaps:string[];next_steps:string[];checkpoint_step:number;duplicate_reads:number}; title?: string | null; answer_truncated?: boolean; id: string; conversation_id?: string; prompt: string; mode: string; status: string; input_tokens: number; output_tokens: number; /** Provider-reported USD cost; null or absent means not reported. */ cost?: number | null; /** True when some requests in the task reported no cost. */ cost_partial?: boolean; step: number; answer: string; error: string; generation: number; created_at: string };

export type Job = {superseded?:boolean;parent_run_id?:string|null;id:string;source_id:string;name:string;kind:string;status:string;error:string;created_at:string};

export type AnalysisStatus = { run_id: string; state: string; current: boolean; total: number; complete: number; running: number; blocked: number; findings: number; model_manifest: string; usage?: {input_tokens:number;output_tokens:number;cost:number|null;unreported:boolean}; blockers: {unit_id:string;source_id:string|null;kind:string;reason:string}[]; pause_reason?: string | null; gaps?: number; coverage_gaps?: {unit_id:string;source_id:string|null;kind:string;reason:string}[]; version: string; human_review: string };

export type Snapshot = { analysis_status?: AnalysisStatus | null; effective_ai?: {route:string;model:string;effort:string|null}; event_seq?: number; automatic_analysis?: { files: number; prepared: number; pending: number; failed: number; review_task: string | null; review_state: string; note: string }; ai_config?: AIConfig; jobs?: Job[]; job_next_cursor?:number|null; attention_jobs?:Job[]; attention_next_cursor?:number|null; source_next_cursor?:{created_at:string;id:string}|null; record_next_cursor?:{updated_at:string;id:string}|null; issues?: {task_id:string;name:string;error:string;count:number;latest_receipt:string;created_at:string}[]; counts?: {audit_seq:number;source_count:number;source_bytes:number;record_count:number;task_count:number;job_count:number;jobs_queued:number;jobs_running:number;jobs_failed:number;jobs_attention:number;jobs_complete:number;chat_pause?:string|null}; viewer_request?: {id:string;source_id:string;time_seconds?:number|null;page?:number|null}|null; id: string; name: string; root: string; generation: number; session_epoch?: number; sources: Source[]; records: RecordSummary[]; settings: Settings; tasks: Task[] };

export type Revision = { revision: number; title: string; content: string; actor: string; review: string; reason: string; task_id: string | null; created_at: string };

export type Selection = { type: 'source' | 'record'; id: string; locator?: string } | null;

export type TextPage = { text: string; start: number; end: number; total_lines: number; revision: number | null; historical?: boolean; locator: string; truncated_long_lines: boolean; /** Read straight from a large original that is not indexed; not citable by line. */ raw_original?: boolean; note?: string };

export type Action = { id: string; name: string; input: string; output: string; status: string; created_at: string };

export type SearchResult = { source_id: string; name: string; excerpt: string; locator: string };
