import { Worker } from "node:worker_threads";
import { resolve } from "node:path";
import { CURRENT_SESSION_VERSION, type SessionEntry } from "@earendil-works/pi-coding-agent";
import { sessionReaderWorkerSource } from "./session-reader-worker.ts";

type Position = { id: string | null; offset: number };
type ConversationPage = {
	messages: Array<{ id: string; role: "user" | "assistant"; text: string; continued?: boolean }>;
	position: Position;
	hasMore: boolean;
};
type BranchCache = { epoch: number; revision: number; size: number; byId: Map<string, SessionEntry>; entries: readonly SessionEntry[] };
const branches = new Map<string, BranchCache>();
let worker: Worker | undefined;
let sequence = 0;
const pending = new Map<number, { resolve(value: any): void; reject(error: Error): void }>();

function request<T>(value: Record<string, unknown>): Promise<T> {
	if (!worker) {
		const owned = new Worker(sessionReaderWorkerSource, { eval: true });
		worker = owned;
		owned.on("message", (message: { id: number; value?: unknown; error?: { message: string; code?: string } }) => {
			const waiter = pending.get(message.id);
			if (!waiter) return;
			pending.delete(message.id);
			if (message.error) waiter.reject(Object.assign(new Error(message.error.message), { code: message.error.code }));
			else waiter.resolve(message.value);
			if (!pending.size) owned.unref();
		});
		const fail = (error: Error) => {
			if (worker !== owned) return;
			worker = undefined;
			branches.clear();
			for (const waiter of pending.values()) waiter.reject(error);
			pending.clear();
		};
		owned.on("error", fail);
		owned.on("exit", code => fail(new Error(`Session reader worker exited (${code}); retry inspection.`)));
	}
	const owned = worker;
	owned.ref();
	return new Promise<T>((resolve, reject) => {
		const id = ++sequence;
		pending.set(id, { resolve, reject });
		try { owned.postMessage({ ...value, id }); }
		catch (error) {
			pending.delete(id);
			if (!pending.size) owned.unref();
			reject(error);
		}
	});
}

/** Async read-only history pagination. Giant JSON records are parsed off the UI thread. */
export function readConversationPageAsync(
	sessionFile: string,
	expected: { sessionId: string; cwd: string },
	position: Position,
	limit: number,
	maxChars: number,
): Promise<ConversationPage> {
	return request({ kind: "page", path: sessionFile, expected: { ...expected, version: CURRENT_SESSION_VERSION }, position, limit, maxChars });
}

/**
 * Complete native active branch, including pre-compaction entries. No session is
 * created, repaired or migrated. Only changed entries cross the worker boundary;
 * unchanged entry objects retain identity across repeated reads and appends.
 * The cache is bounded; eviction may replace identities on the next cold read.
 */
export async function readSessionBranch(sessionFile: string, cwd: string): Promise<readonly SessionEntry[]> {
	const path = resolve(sessionFile);
	const cached = branches.get(path);
	const result = await request<{
		epoch: number; revision: number; size: number; ids?: string[]; entries: SessionEntry[];
	}>({ kind: "branch", path, expected: { cwd, version: CURRENT_SESSION_VERSION }, epoch: cached?.epoch, revision: cached?.revision });
	const current = branches.get(path);
	const byId = current?.epoch === result.epoch ? current.byId : new Map<string, SessionEntry>();
	for (const entry of result.entries) byId.set(entry.id, entry);
	const entries = result.ids ? result.ids.map(id => {
		const entry = byId.get(id);
		if (!entry) throw new Error("Session reader branch delta is incomplete; retry inspection.");
		return entry;
	}) : current?.entries ?? [];
	branches.delete(path);
	branches.set(path, { epoch: result.epoch, revision: result.revision, size: result.size, byId, entries });
	let bytes = 0;
	for (const item of branches.values()) bytes += item.size;
	for (const [key, item] of branches) {
		if (branches.size <= 8 && bytes <= 128 * 1024 * 1024) break;
		branches.delete(key);
		bytes -= item.size;
	}
	return entries;
}

/** Metadata-only diagnostic counters used by offline performance regressions. */
export function sessionReaderStatsAsync(): Promise<{
	bytesRead: number; parsedLines: number; fullLoads: number; incrementalLoads: number; cachedFiles: number;
}> {
	return request({ kind: "stats" });
}

/** Explicit shutdown for owned offline fixtures; the idle worker is otherwise unref'd. */
export async function disposeSessionReaderAsync(): Promise<void> {
	const owned = worker;
	worker = undefined;
	branches.clear();
	for (const waiter of pending.values()) waiter.reject(new Error("Session reader disposed."));
	pending.clear();
	await owned?.terminate();
}
