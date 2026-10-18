import { randomUUID } from "node:crypto";
import type { AgentRecord, UsageSummary } from "./types.ts";

const TEXT_LIMIT = 4000;

function boundedTail(text: string, limit = TEXT_LIMIT): string {
	return text.length <= limit ? text : text.slice(-limit);
}

function messageText(message: any): string {
	if (!message || message.role !== "assistant" || !Array.isArray(message.content)) return "";
	return message.content
		.filter((part: any) => part?.type === "text" && typeof part.text === "string")
		.map((part: any) => part.text)
		.join("\n");
}

function addUsage(target: UsageSummary, usage: any): void {
	if (!usage || typeof usage !== "object") return;
	target.input += Number(usage.input) || 0;
	target.output += Number(usage.output) || 0;
	target.cacheRead += Number(usage.cacheRead) || 0;
	target.cacheWrite += Number(usage.cacheWrite) || 0;
	target.totalTokens += Number(usage.totalTokens) || 0;
	target.cost += Number(usage.cost?.total) || 0;
}

function shortArgs(args: unknown): string {
	// Bound work before serialization, not after a multi-megabyte stringify. Do
	// not invoke toJSON/getters: this is a display preview, not tool execution.
	let remaining = 177;
	let visits = 32;
	let truncated = false;
	const parts: string[] = [];
	const seen = new Set<object>();
	const append = (text: string) => {
		if (text.length > remaining) truncated = true;
		parts.push(text.slice(0, remaining));
		remaining = Math.max(0, remaining - text.length);
	};
	const quoted = (text: string, maximum = 120) => {
		const limit = Math.min(maximum, remaining);
		if (text.length > limit) truncated = true;
		append(JSON.stringify(text.slice(0, limit)));
	};
	const visit = (value: unknown, depth: number): void => {
		if (!remaining) { truncated = true; return; }
		if (--visits < 0) { truncated = true; quoted("[…]"); return; }
		if (typeof value === "string") { quoted(value); return; }
		if (value === null || typeof value !== "object") {
			append(typeof value === "bigint" ? '"[bigint]"' : JSON.stringify(value) ?? "null");
			return;
		}
		if (seen.has(value)) { quoted("[Circular]"); return; }
		if (depth >= 3) { truncated = true; quoted("[…]"); return; }
		seen.add(value);
		const array = Array.isArray(value);
		append(array ? "[" : "{");
		let count = 0;
		// Object.keys() would allocate/scan every key before applying the bound.
		if (array) {
			for (let i = 0; i < Math.min(value.length, 8) && remaining; i++) {
				if (count++) append(",");
				const descriptor = Object.getOwnPropertyDescriptor(value, i);
				visit(descriptor && "value" in descriptor ? descriptor.value : "[Getter]", depth + 1);
			}
			if (value.length > count) truncated = true;
		} else {
			let inspected = 0;
			for (const key in value) {
				if (++inspected > 8 || !remaining) { truncated = true; break; }
				if (!Object.prototype.hasOwnProperty.call(value, key)) continue;
				const descriptor = Object.getOwnPropertyDescriptor(value, key);
				if (!descriptor?.enumerable) continue;
				if ("value" in descriptor && (descriptor.value === undefined || typeof descriptor.value === "function" || typeof descriptor.value === "symbol")) continue;
				if (count++) append(",");
				quoted(key, 40); append(":");
				visit("value" in descriptor ? descriptor.value : "[Getter]", depth + 1);
			}
		}
		append(array ? "]" : "}");
		seen.delete(value);
	};
	try { visit(args ?? {}, 0); }
	catch { return "{}"; }
	return parts.join("") + (truncated ? "…" : "");
}

export interface ParsedChildState {
	finalText: string;
	stopReason?: string;
	errorMessage?: string;
}

export function applyChildEvent(record: AgentRecord, state: ParsedChildState, event: any): boolean {
	let important = false;
	const now = new Date().toISOString();

	switch (event?.type) {
		case "session":
			if (typeof event.id === "string") record.sessionId = event.id;
			break;
		case "agent_start":
			record.executionId = randomUUID();
			state.finalText = "";
			state.stopReason = undefined;
			state.errorMessage = undefined;
			record.status = "thinking";
			record.activity = "thinking";
			record.currentTool = undefined;
			record.error = undefined;
			record.finishedAt = undefined;
			record.resultsDelivered = false;
			record.resultsPreviewed = false;
			record.footerDismissed = false;
			important = true;
			break;
		case "message_start":
			if (event.message?.role === "assistant") {
				record.status = "thinking";
				record.activity = "thinking";
				record.latestText = undefined;
				important = true;
			}
			break;
		case "message_update": {
			const update = event.assistantMessageEvent;
			if (update?.type === "text_delta" && typeof update.delta === "string") {
				record.latestText = boundedTail(`${record.latestText ?? ""}${update.delta}`);
				record.activity = "responding";
			} else if (update?.type === "thinking_delta") {
				record.activity = "thinking";
			} else if (update?.type === "toolcall_start") {
				record.status = "running_tool";
				record.currentTool = typeof update.toolName === "string" ? update.toolName : "tool";
				record.activity = `preparing ${record.currentTool}`;
				important = true;
			}
			break;
		}
		case "tool_execution_start":
			record.status = "running_tool";
			record.currentTool = `${event.toolName ?? "tool"} ${shortArgs(event.args)}`;
			record.activity = `running ${event.toolName ?? "tool"}`;
			important = true;
			break;
		case "tool_execution_end":
			record.currentTool = undefined;
			record.status = "thinking";
			record.activity = event.isError ? `${event.toolName ?? "tool"} failed` : "thinking";
			important = true;
			break;
		case "message_end": {
			const text = messageText(event.message);
			if (event.message?.role === "user" || text) {
				record.conversationRevision = (record.conversationRevision ?? 0) + 1;
			}
			if (event.message?.role === "assistant") {
				if (text) {
					state.finalText = text;
					record.latestText = boundedTail(text);
				}
				if (typeof event.message.model === "string") record.model = `${event.message.provider}/${event.message.model}`;
				state.stopReason = event.message.stopReason;
				state.errorMessage = event.message.errorMessage;
				record.activity = "thinking";
				addUsage(record.usage, event.message.usage);
				important = true;
			}
			break;
		}
		case "agent_end":
			record.status = "idle";
			record.activity = "finishing";
			important = true;
			break;
	}

	record.updatedAt = now;
	return important;
}

export function toolUsage(usage: UsageSummary) {
	return {
		input: usage.input,
		output: usage.output,
		cacheRead: usage.cacheRead,
		cacheWrite: usage.cacheWrite,
		totalTokens: usage.totalTokens,
		cost: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			total: usage.cost,
		},
	};
}
