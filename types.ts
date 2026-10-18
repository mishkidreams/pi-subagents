export type AgentStatus =
	| "queued"
	| "starting"
	| "thinking"
	| "running_tool"
	| "idle"
	| "completed"
	| "failed"
	| "cancelled";

export interface UsageSummary {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	totalTokens: number;
	cost: number;
}

export type ResultRoute = "parent" | "manual";

export interface AgentRecord {
	version: 1;
	runId: string;
	parentRunId: string;
	rootRunId: string;
	sessionId: string;
	sessionFile?: string;
	/** Distinguishes a resumed process from stale writers of the same run. */
	processInstanceId?: string;
	pid?: number;
	/** Start token used to reject stale PID reuse. Linux /proc ticks, or Windows creation time in Unix milliseconds. */
	pidStartTime?: string;
	name: string;
	task: string;
	cwd: string;
	model: string;
	thinking: string;
	tools?: string[];
	depth: number;
	maxDepth: number;
	status: AgentStatus;
	/** Fresh on each agent_start; scopes parent-owned result/UI markers to one execution. */
	executionId?: string;
	/** Manual conversation stays readable but never enters automatic parent delivery. Omitted means parent (legacy). */
	resultRoute?: ResultRoute;
	/** Monotonic visible user/assistant message count, retained across continuations. */
	conversationRevision?: number;
	/** Set when the user started a newer turn: hide from the footer tree. History stays reviewable. */
	footerDismissed?: boolean;
	/**
	 * Set once this child's result reached the parent through an authoritative
	 * delivery (idle batch or an explicit check). Auto-appends to tool output set
	 * resultsPreviewed instead: they are best-effort and stay collectable by check.
	 */
	resultsDelivered?: boolean;
	/** Set after this child's result was appended to a parent tool result. */
	resultsPreviewed?: boolean;
	activity?: string;
	currentTool?: string;
	latestText?: string;
	error?: string;
	usage: UsageSummary;
	startedAt: string;
	updatedAt: string;
	finishedAt?: string;
}

export interface ModelAlias {
	/** Exact provider/model selector; never another alias. */
	model: string;
	/** Omitted means enabled. False hides and disables this alias, not the underlying model. */
	enabled?: boolean;
	thinking?: string;
	description?: string;
}

export interface SubagentSettings {
	/** Runtime provenance: a depth flag overrides file limits throughout its subtree. */
	maxDepthFlagOverride?: boolean;
	defaultModel?: string;
	defaultThinking?: string;
	modelAliases?: Record<string, ModelAlias>;
	/** Only enabled aliases may launch children; saved canonical targets must remain allowlisted. */
	aliasesOnly?: boolean;
	maxDepth: number;
	maxConcurrency: number;
	/** Maximum UTF-16 code units per child RPC stdout record (default 64 Mi). */
	rpcMaxLineChars?: number;
}

export interface SpawnAgentInput {
	task: string;
	name?: string;
	cwd?: string;
	model?: string;
	thinking?: string;
	tools?: string[];
}

export const EMPTY_USAGE: UsageSummary = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: 0,
};
