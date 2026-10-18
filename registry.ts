import { execFile, execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
	existsSync,
	mkdirSync,
	readFileSync,
	readdirSync,
	renameSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { AgentRecord, AgentStatus, ResultRoute } from "./types.ts";

const TERMINAL = new Set<AgentStatus>(["completed", "failed", "cancelled"]);
const LOCK_STALE_MS = 30_000;
const LOCK_WAIT_MS = 5_000;
const REPLACE_ATTEMPTS = 8;
const TRANSIENT_FS_CODES = new Set(["EPERM", "EACCES", "EBUSY"]);
const WINDOWS_IDENTITY_FRESH_MS = 1_000;
const WINDOWS_PROBE_BACKOFF_MS = 2_000;

interface CachedWindowsStart {
	startTime: string;
	fetchedAt: number;
}

const windowsStartTimeCache = new Map<number, CachedWindowsStart>();
const windowsProbeFailures = new Map<number, number>();
const windowsProbeInflight = new Set<number>();

interface CancellationMarker {
	version: 1;
	runId: string;
	cancelledAt: string;
	error?: string;
}

export function isTerminalStatus(status: AgentStatus): boolean {
	return TERMINAL.has(status);
}

export function registryDir(agentDir: string): string {
	return join(agentDir, "subagents", "runs");
}

function safeRunId(runId: string): string {
	return runId.replace(/[^a-zA-Z0-9._-]/g, "_");
}

function recordPath(agentDir: string, runId: string): string {
	return join(registryDir(agentDir), `${safeRunId(runId)}.json`);
}

function markerPath(agentDir: string, runId: string, kind: "cancelled" | "closed"): string {
	return join(registryDir(agentDir), `${safeRunId(runId)}.${kind}`);
}

function sleepSync(ms: number): void {
	Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** Windows MoveFileEx fails with EPERM while Defender or an indexer holds the destination. */
export function isTransientFsError(error: unknown): boolean {
	const code = (error as NodeJS.ErrnoException | undefined)?.code;
	return !!code && TRANSIENT_FS_CODES.has(code);
}

/** Replace `to` with `from`. Retries the lock errors that kill a POSIX rename on Windows. */
export function renameReplacing(from: string, to: string): void {
	for (let attempt = 0; attempt < REPLACE_ATTEMPTS; attempt++) {
		try {
			renameSync(from, to);
			return;
		} catch (error) {
			if (!isTransientFsError(error) || attempt === REPLACE_ATTEMPTS - 1) throw error;
			sleepSync(15 * (attempt + 1));
		}
	}
}

function atomicWrite(target: string, contents: string, retryRename = true): void {
	const temporary = `${target}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
	// mode is a chmod on Windows and can itself fail with EPERM. The directory is already private.
	const options: { encoding: "utf8"; mode?: number } = { encoding: "utf8" };
	if (process.platform !== "win32") options.mode = 0o600;
	writeFileSync(temporary, contents, options);
	try {
		if (retryRename) renameReplacing(temporary, target);
		else renameSync(temporary, target);
		// A later caller must not join a snapshot started before this local write.
		snapshots.delete(resolve(dirname(target)));
	} catch (error) {
		rmSync(temporary, { force: true });
		throw error;
	}
}

/** Windows replacement retries that leave input/RPC/close callbacks runnable. */
export async function renameReplacingAsync(from: string, to: string): Promise<void> {
	for (let attempt = 0; ; attempt++) {
		try { await rename(from, to); return; }
		catch (error) {
			if (!isTransientFsError(error) || attempt === REPLACE_ATTEMPTS - 1) throw error;
			await delay(15 * (attempt + 1));
		}
	}
}

/** The UI/tool path must let Windows close handles while replacement is retried. */
async function atomicWriteAsync(target: string, contents: string): Promise<void> {
	const temporary = `${target}.tmp-${process.pid}-${randomToken()}`;
	try {
		await writeFile(temporary, contents, { encoding: "utf8", ...(process.platform === "win32" ? {} : { mode: 0o600 }) });
		await renameReplacingAsync(temporary, target);
		snapshots.delete(resolve(dirname(target)));
	} finally {
		await rm(temporary, { force: true }).catch(() => {});
	}
}

function writeCancellationMarker(agentDir: string, record: AgentRecord, retryRename = true): void {
	const target = markerPath(agentDir, record.runId, "cancelled");
	if (existsSync(target)) return;
	const marker: CancellationMarker = {
		version: 1,
		runId: record.runId,
		cancelledAt: record.finishedAt ?? new Date().toISOString(),
		error: record.error,
	};
	atomicWrite(target, `${JSON.stringify(marker)}\n`, retryRename);
}

function readCancellationMarker(agentDir: string, runId: string): CancellationMarker | undefined {
	const target = markerPath(agentDir, runId, "cancelled");
	if (!existsSync(target)) return undefined;
	let text = "";
	try { text = readFileSync(target, "utf8"); } catch { /* The marker still counts. */ }
	return parseCancellationMarker(text, runId);
}

function parseCancellationMarker(text: string, runId: string): CancellationMarker {
	try {
		const value = JSON.parse(text) as Partial<CancellationMarker> | null;
		if (value?.version === 1 && value.runId === runId && typeof value.cancelledAt === "string") {
			return value as CancellationMarker;
		}
	} catch {
		// The marker's existence is enough to keep cancellation monotonic.
	}
	return { version: 1, runId, cancelledAt: new Date().toISOString(), error: "Cancelled" };
}

const RESULT_STATE_FLAGS = ["resultsDelivered", "resultsPreviewed", "footerDismissed"] as const;
type ResultStateFlag = typeof RESULT_STATE_FLAGS[number];

interface RecordMarkers {
	flags: readonly ResultStateFlag[];
	cancellation?: CancellationMarker;
	closed: boolean;
}

function resultStatePath(agentDir: string, record: AgentRecord, flag: ResultStateFlag): string {
	return join(registryDir(agentDir), `${safeRunId(record.runId)}.${safeRunId(record.executionId ?? "legacy")}.${flag}`);
}

export function resultKey(record: AgentRecord): string {
	return JSON.stringify([record.runId, record.executionId ?? record.finishedAt ?? record.updatedAt]);
}

function resultArchivePath(agentDir: string, record: AgentRecord): string {
	return join(agentDir, "subagents", "results", `${safeRunId(record.runId)}.json`);
}

/**
 * Parent/UI writes must never replace the execution owner's JSON snapshot.
 * Each flag is an independent monotonic fact scoped to the observed execution,
 * so even a delayed cross-process write cannot mark a newer turn or regress it.
 */
export function markRecordResultState(agentDir: string, record: AgentRecord, flag: ResultStateFlag): void {
	mkdirSync(registryDir(agentDir), { recursive: true, mode: 0o700 });
	atomicWrite(resultStatePath(agentDir, record, flag), "true\n");
	if (flag === "resultsDelivered") {
		// This is an outbox, not a second history. Keep ordinary tool results from
		// rereading every old full response for the lifetime of the installation.
		try {
			withRecordLock(agentDir, record.runId, () => {
				const target = resultArchivePath(agentDir, record);
				if (existsSync(target) && resultKey(JSON.parse(readFileSync(target, "utf8"))) === resultKey(record)) rmSync(target, { force: true });
			}, 0);
		} catch { /* The durable marker still suppresses it; never remove a newer result. */ }
	}
}

/** Async parent/UI counterpart: no synchronous filesystem work or retry sleeps. */
export async function markRecordResultStateAsync(agentDir: string, record: AgentRecord, flag: ResultStateFlag): Promise<void> {
	await mkdir(registryDir(agentDir), { recursive: true, mode: 0o700 });
	await atomicWriteAsync(resultStatePath(agentDir, record, flag), "true\n");
	if (flag !== "resultsDelivered") return;
	try {
		await withAsyncRecordLock(agentDir, record.runId, async () => {
			const target = resultArchivePath(agentDir, record);
			const archived = JSON.parse(await readFile(target, "utf8")) as AgentRecord;
			if (resultKey(archived) === resultKey(record)) await rm(target, { force: true });
		});
	} catch { /* The durable marker suppresses it; never remove a newer execution's outbox. */ }
}

function closedPath(agentDir: string, record: AgentRecord): string {
	return markerPath(agentDir, record.processInstanceId ? `${record.runId}.${record.processInstanceId}` : record.runId, "closed");
}

function readMarkers(agentDir: string, record: AgentRecord): RecordMarkers {
	return {
		flags: RESULT_STATE_FLAGS.filter((flag) => existsSync(resultStatePath(agentDir, record, flag))),
		cancellation: readCancellationMarker(agentDir, record.runId),
		closed: existsSync(closedPath(agentDir, record)),
	};
}

function applyMarkers(record: AgentRecord, { flags, cancellation, closed }: RecordMarkers): AgentRecord {
	let result = record;
	for (const flag of flags) result = { ...result, [flag]: true };
	if (cancellation) {
		result = {
			...result,
			status: "cancelled",
			activity: "cancelled",
			currentTool: undefined,
			error: cancellation.error ?? result.error ?? "Cancelled",
			finishedAt: cancellation.cancelledAt,
			updatedAt:
				Date.parse(result.updatedAt) > Date.parse(cancellation.cancelledAt)
					? result.updatedAt
					: cancellation.cancelledAt,
		};
	}
	if (closed) result = { ...result, pid: undefined, pidStartTime: undefined };
	return result;
}

/** Preserve a finished delegation before a manual continuation can replace its live record.
 * Delivery markers remain execution-scoped; cancellation of a later turn must not rewrite this result.
 */
function archiveParentResult(agentDir: string, record: AgentRecord, retryRename = true): void {
	if (!isTerminalStatus(record.status) || record.resultRoute === "manual" || record.resultsDelivered) return;
	const dir = join(agentDir, "subagents", "results");
	mkdirSync(dir, { recursive: true, mode: 0o700 });
	const target = resultArchivePath(agentDir, record);
	if (!existsSync(target) || resultKey(JSON.parse(readFileSync(target, "utf8"))) !== resultKey(record)) {
		// One latest delegation per child, preserving the pre-existing coalescing
		// contract. Manual turns never replace this pending parent result.
		atomicWrite(target, `${JSON.stringify({ ...record, pid: undefined, pidStartTime: undefined })}\n`, retryRename);
	}
}

/** Finished parent-directed executions, including those superseded by a later manual turn. */
export function readParentResults(agentDir: string): AgentRecord[] {
	const current = readRecords(agentDir);
	const live = new Map(current.map((record) => [record.runId, record]));
	const records = new Map<string, AgentRecord>();
	const add = (record: AgentRecord) => {
		if (!isTerminalStatus(record.status) || record.resultRoute === "manual") return;
		// Only delivery facts apply to archived executions, never a later run-wide cancellation.
		for (const flag of RESULT_STATE_FLAGS) {
			if (existsSync(resultStatePath(agentDir, record, flag))) record = { ...record, [flag]: true };
		}
		if (!record.resultsDelivered) records.set(record.runId, record);
	};
	const dir = join(agentDir, "subagents", "results");
	if (existsSync(dir)) {
		for (const name of readdirSync(dir)) {
			if (!name.endsWith(".json")) continue;
			try {
				const record = JSON.parse(readFileSync(join(dir, name), "utf8")) as AgentRecord;
				const active = live.get(record.runId);
				// A newer parent-requested turn supersedes the old snapshot, exactly
				// as before. Only manual continuation preserves a previous delegation.
				if (active && active.resultRoute !== "manual" &&
					(!isTerminalStatus(active.status) || resultKey(active) !== resultKey(record))) continue;
				if (record.version === 1 && typeof record.runId === "string") add(record);
			} catch { /* A damaged historical result must not hide other results. */ }
		}
	}
	// Compatibility with records written before the result archive existed.
	for (const record of current) add(record);
	return [...records.values()];
}

/** Same delivery/ownership rules as readParentResults, without scanning history on the event loop.
 * A waiter can pass its already loaded full snapshot instead of taking a second one.
 */
export async function readParentResultsAsync(agentDir: string, current?: readonly AgentRecord[]): Promise<AgentRecord[]> {
	current ??= await readRecordsAsync(agentDir);
	const live = new Map(current.map((record) => [record.runId, record]));
	const records = new Map<string, AgentRecord>();
	let markerNames: Set<string>;
	try { markerNames = new Set(await readdir(registryDir(agentDir))); }
	catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; markerNames = new Set(); }
	const add = (record: AgentRecord) => {
		if (!isTerminalStatus(record.status) || record.resultRoute === "manual") return;
		for (const flag of RESULT_STATE_FLAGS) {
			if (markerNames.has(resultStatePath(agentDir, record, flag).slice(registryDir(agentDir).length + 1))) record = { ...record, [flag]: true };
		}
		if (!record.resultsDelivered) records.set(record.runId, record);
	};
	const dir = join(agentDir, "subagents", "results");
	let names: string[];
	try { names = await readdir(dir); }
	catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; names = []; }
	const archived = await readRecordFiles(dir, names);
	for (const record of archived) {
		const active = live.get(record.runId);
		if (active && active.resultRoute !== "manual" &&
			(!isTerminalStatus(active.status) || resultKey(active) !== resultKey(record))) continue;
		add(record);
	}
	for (const record of current) add(record);
	return [...records.values()];
}

/**
 * Persist an execution-owner record atomically. Parent/UI flags must use
 * markRecordResultState instead. Result flags, cancellation and close markers are
 * separate monotonic facts, so a stale writer in another process cannot undo
 * these facts by replacing the JSON record later (within the same execution).
 */
export class StaleSubagentProcessError extends Error {
	constructor() { super("Subagent process has been replaced by a resumed process"); }
}

export function saveRecord(agentDir: string, record: AgentRecord, options?: { retryRename?: boolean }): AgentRecord {
	return saveRecordWithRenameMode(agentDir, record, options?.retryRename !== false);
}

/** Message admission can wait for a Windows open handle, but must not block its close callbacks. */
export async function saveRecordAsync(agentDir: string, record: AgentRecord, signal?: AbortSignal): Promise<AgentRecord> {
	const deadline = Date.now() + 2_000;
	while (true) {
		if (signal?.aborted) throw new Error("Subagent message was aborted");
		try {
			return await withRecordLockAsync(agentDir, record.runId,
				() => saveRecordWithRenameMode(agentDir, record, false), Math.max(0, deadline - Date.now()), signal);
		}
		catch (error) {
			if (!isTransientFsError(error) || (error as NodeJS.ErrnoException).syscall !== "rename" || Date.now() >= deadline) throw error;
			await delay(25, undefined, { signal });
		}
	}
}

function saveRecordWithRenameMode(agentDir: string, record: AgentRecord, retryRename: boolean): AgentRecord {
	return withRecordLock(agentDir, record.runId, () => {
		const target = recordPath(agentDir, record.runId);
		const current = existsSync(target) ? JSON.parse(readFileSync(target, "utf8")) as AgentRecord : undefined;
		if (current?.processInstanceId && current.processInstanceId !== record.processInstanceId) {
			throw new StaleSubagentProcessError();
		}
		if (current) archiveParentResult(agentDir, applyMarkers(current, readMarkers(agentDir, current)), retryRename);
		if (record.status === "cancelled") writeCancellationMarker(agentDir, record, retryRename);
		const saved = applyMarkers(record, readMarkers(agentDir, record));
		atomicWrite(target, `${JSON.stringify(saved)}\n`, retryRename);
		archiveParentResult(agentDir, saved, retryRename);
		return saved;
	}, 0);
}

/** Reserve one new process, retaining run/session identity and permanent cancellation. */
export function claimRecordForResume(agentDir: string, record: AgentRecord, resultRoute: ResultRoute = "parent", options?: { retryRename?: boolean }): AgentRecord {
	return withRecordLock(agentDir, record.runId, () => {
		const current = readRecord(agentDir, record.runId);
		if (!current || current.processInstanceId !== record.processInstanceId) throw new StaleSubagentProcessError();
		if (current.status === "cancelled" || isRecordCancelled(agentDir, record.runId)) throw new Error(`${record.name} was cancelled`);
		if (!isTerminalStatus(current.status) || isRecordedProcessAlive(current)) throw new Error(`${record.name} is still running`);
		const retryRename = options?.retryRename !== false;
		archiveParentResult(agentDir, current, retryRename);
		const next: AgentRecord = {
			...current, processInstanceId: randomUUID(), executionId: randomUUID(), resultRoute,
			pid: undefined, pidStartTime: undefined, status: "queued", activity: "waiting for a concurrency slot",
			latestText: undefined, error: undefined, finishedAt: undefined,
			resultsDelivered: false, resultsPreviewed: false, footerDismissed: false,
			updatedAt: new Date().toISOString(),
		};
		atomicWrite(recordPath(agentDir, next.runId), `${JSON.stringify(next)}\n`, retryRename);
		return next;
	}, 0);
}

/** Mark a child PID as permanently cleared before writing its final record. */
export function clearRecordPid(agentDir: string, record: AgentRecord, options?: { retryRename?: boolean }): AgentRecord {
	const dir = registryDir(agentDir);
	mkdirSync(dir, { recursive: true, mode: 0o700 });
	const target = closedPath(agentDir, record);
	if (!existsSync(target)) atomicWrite(target, `${new Date().toISOString()}\n`, options?.retryRename !== false);
	return saveRecord(agentDir, { ...record, pid: undefined, pidStartTime: undefined }, options);
}

export function isRecordCancelled(agentDir: string, runId: string): boolean {
	return existsSync(markerPath(agentDir, runId, "cancelled"));
}

function randomToken(): string {
	return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

const heldRecordLocks = new Set<string>();

/** One nonblocking attempt, interoperable with the synchronous owner's lock.
 * Async operations never borrow heldRecordLocks: an await must not admit another writer.
 */
async function withAsyncRecordLock<T>(agentDir: string, runId: string, operation: () => Promise<T>): Promise<T> {
	const lock = join(registryDir(agentDir), `${safeRunId(runId)}.lock`);
	const token = `${process.pid}-${randomToken()}`;
	await mkdir(lock, { mode: 0o700 });
	try {
		await writeFile(join(lock, "owner"), `${token}\n`, { encoding: "utf8", mode: 0o600 });
		return await operation();
	} finally {
		// The owner cannot be considered stale while this short async operation is alive.
		try {
			if ((await readFile(join(lock, "owner"), "utf8")).trim() === token) await rm(lock, { recursive: true, force: true });
		} catch { /* Never remove a lock we no longer own. */ }
	}
}

/** Wait asynchronously, then run one synchronous critical section (including nested owner writes).
 * Never put an async callback here: heldRecordLocks must not span an await.
 */
export async function withRecordLockAsync<T>(
	agentDir: string, runId: string, operation: () => T, waitMs = LOCK_WAIT_MS, signal?: AbortSignal,
): Promise<T> {
	const deadline = Date.now() + waitMs;
	while (true) {
		if (signal?.aborted) throw new Error("Subagent record operation was aborted");
		let entered = false;
		try { return withRecordLock(agentDir, runId, () => { entered = true; return operation(); }, 0); }
		catch (error) {
			// Retrying a partially executed callback could spawn or deliver twice.
			if (entered || (error as NodeJS.ErrnoException).code !== "EBUSY" || Date.now() >= deadline) throw error;
			await delay(Math.min(10, Math.max(1, deadline - Date.now())), undefined, { signal });
		}
	}
}

/** Serialize synchronous record operations; nested calls share this process\'s lock. */
export function withRecordLock<T>(agentDir: string, runId: string, operation: () => T, waitMs = LOCK_WAIT_MS): T {
	const dir = registryDir(agentDir);
	mkdirSync(dir, { recursive: true, mode: 0o700 });
	const lock = join(dir, `${safeRunId(runId)}.lock`);
	if (heldRecordLocks.has(lock)) return operation();
	const token = `${process.pid}-${randomToken()}`;
	const deadline = Date.now() + waitMs;
	while (true) {
		try {
			mkdirSync(lock, { mode: 0o700 });
			try {
				writeFileSync(join(lock, "owner"), `${token}\n`, { encoding: "utf8", mode: 0o600 });
			} catch (error) {
				rmSync(lock, { recursive: true, force: true });
				throw error;
			}
			break;
		} catch (error: any) {
			if (error?.code !== "EEXIST") throw error;
			let stale = false;
			try {
				const age = Date.now() - statSync(lock).mtimeMs;
				if (age > LOCK_STALE_MS) stale = true;
				else {
					const owner = Number(readFileSync(join(lock, "owner"), "utf8").trim().split("-", 1)[0]);
					stale = Number.isInteger(owner) && owner > 0 && !isProcessAlive(owner);
				}
			} catch {
				// A creator may be between mkdir and writing owner. Give it time.
			}
			if (stale) {
				const quarantine = `${lock}.stale-${process.pid}-${randomToken()}`;
				try {
					// Never sleep on a Windows handle while holding up the event loop.
					renameSync(lock, quarantine);
					rmSync(quarantine, { recursive: true, force: true });
					continue;
				} catch {
					// A stale lock that cannot be moved must respect the same deadline.
				}

			}
			if (Date.now() >= deadline) throw Object.assign(new Error(`Subagent record is busy; retry: ${runId}`), { code: "EBUSY" });
			sleepSync(5);
		}
	}
	heldRecordLocks.add(lock);
	try {
		return operation();
	} finally {
		heldRecordLocks.delete(lock);
		try {
			if (readFileSync(join(lock, "owner"), "utf8").trim() === token) {
				rmSync(lock, { recursive: true, force: true });
			}
		} catch {
			// A stale-lock recovery may already have moved this lock aside.
		}
	}
}

function isRecord(value: unknown): value is AgentRecord {
	if (!value || typeof value !== "object") return false;
	const item = value as Partial<AgentRecord>;
	return (
		item.version === 1 &&
		typeof item.runId === "string" &&
		typeof item.parentRunId === "string" &&
		typeof item.rootRunId === "string" &&
		typeof item.sessionId === "string" &&
		typeof item.name === "string" &&
		typeof item.task === "string" &&
		typeof item.cwd === "string" &&
		typeof item.depth === "number" &&
		typeof item.status === "string" &&
		typeof item.startedAt === "string" &&
		typeof item.updatedAt === "string"
	);
}

export function isProcessAlive(pid: number | undefined): boolean {
	if (!pid || pid < 1) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

export interface ProcessIdentity {
	pid: number;
	processGroup: number;
	/** Linux /proc start ticks, or Windows creation time in Unix milliseconds. */
	startTime: string;
}

function windowsIdentityArgs(pid: number): string[] {
	return [
		"-NoProfile",
		"-NonInteractive",
		"-Command",
		`[DateTimeOffset]::new((Get-Process -Id ${pid} -ErrorAction Stop).StartTime.ToUniversalTime()).ToUnixTimeMilliseconds()`,
	];
}

function parseWindowsStartTime(raw: string): string | undefined {
	const output = raw.replace(/^\uFEFF/, "").trim().split(/\r?\n/).at(-1) ?? "";
	return /^\d+$/.test(output) ? output : undefined;
}

function queryWindowsStartTime(pid: number): string | undefined {
	if (!Number.isInteger(pid) || pid < 1) return undefined;
	try {
		const raw = execFileSync("powershell.exe", windowsIdentityArgs(pid), {
			windowsHide: true, encoding: "utf8", timeout: 2000, stdio: ["ignore", "pipe", "pipe"],
		});
		return parseWindowsStartTime(String(raw));
	} catch {
		return undefined;
	}
}

function forgetWindowsProcess(pid: number): void {
	windowsStartTimeCache.delete(pid);
	windowsProbeFailures.delete(pid);
}

function rememberWindowsStartTime(pid: number, startTime: string | undefined): void {
	if (!isProcessAlive(pid)) {
		forgetWindowsProcess(pid);
		return;
	}
	if (!startTime) {
		windowsProbeFailures.set(pid, Date.now());
		windowsStartTimeCache.delete(pid);
		return;
	}
	windowsProbeFailures.delete(pid);
	windowsStartTimeCache.set(pid, { startTime, fetchedAt: Date.now() });
}

/**
 * Ask PowerShell off the caller stack. A failed probe is not filled from the cache.
 * A sample that finishes after this pid died, or after a newer sample was stored,
 * is dropped: the pid may already belong to another process.
 */
export function probeWindowsStartTime(pid: number): Promise<string | undefined> {
	if (!Number.isInteger(pid) || pid < 1) return Promise.resolve(undefined);
	if (!isProcessAlive(pid)) {
		forgetWindowsProcess(pid);
		return Promise.resolve(undefined);
	}
	return new Promise((resolve) => {
		const startedAt = Date.now();
		let sawDeath = false;
		const watch = setInterval(() => {
			if (!isProcessAlive(pid)) sawDeath = true;
		}, 20);
		watch.unref();
		const finish = (startTime: string | undefined) => {
			clearInterval(watch);
			const cached = windowsStartTimeCache.get(pid);
			const newer = !!cached && cached.fetchedAt >= startedAt;
			if (sawDeath || !isProcessAlive(pid)) {
				if (!newer) {
					windowsStartTimeCache.delete(pid);
					windowsProbeFailures.delete(pid);
				}
				// That sample belongs to a process that has exited. Returning it would
				// make a reused pid look like the process a kill is allowed to stop.
				resolve(undefined);
				return;
			}
			if (newer) {
				resolve(cached!.startTime);
				return;
			}
			rememberWindowsStartTime(pid, startTime);
			// The pid can die inside remember. Publish only the sample it kept.
			resolve(windowsStartTimeCache.get(pid)?.startTime);
		};
		try {
			execFile("powershell.exe", windowsIdentityArgs(pid), {
				windowsHide: true, encoding: "utf8", timeout: 2000,
			}, (error, stdout) => {
				const startTime = error ? undefined : parseWindowsStartTime(String(stdout ?? ""));
				finish(startTime);
			});
		} catch {
			clearInterval(watch);
			resolve(undefined);
		}
	});
}

function refreshProcessIdentitySoon(pid: number): void {
	if (windowsProbeInflight.has(pid)) return;
	const failedAt = windowsProbeFailures.get(pid);
	if (failedAt !== undefined && Date.now() - failedAt < WINDOWS_PROBE_BACKOFF_MS) return;
	const cached = windowsStartTimeCache.get(pid);
	if (cached && Date.now() - cached.fetchedAt < WINDOWS_IDENTITY_FRESH_MS) return;
	windowsProbeInflight.add(pid);
	void probeWindowsStartTime(pid).finally(() => {
		windowsProbeInflight.delete(pid);
	});
}

function readWindowsProcessIdentity(pid: number, refresh: boolean): ProcessIdentity | undefined {
	if (!Number.isInteger(pid) || pid < 1) return undefined;
	if (!isProcessAlive(pid)) {
		forgetWindowsProcess(pid);
		return undefined;
	}
	const queried = (): ProcessIdentity | undefined => {
		const startTime = queryWindowsStartTime(pid);
		// A blocking query cannot see a reuse that finishes before this check: the
		// event loop is stalled. Callers that store a start time for a later kill
		// use probeWindowsStartTime, whose death watch runs during the query.
		if (!isProcessAlive(pid)) {
			forgetWindowsProcess(pid);
			return undefined;
		}
		rememberWindowsStartTime(pid, startTime);
		// remember drops the sample if the pid dies before the store.
		const stored = windowsStartTimeCache.get(pid)?.startTime;
		if (!stored || stored !== startTime) return undefined;
		return { pid, processGroup: pid, startTime: stored };
	};
	if (!refresh) {
		const cached = windowsStartTimeCache.get(pid);
		if (cached) return { pid, processGroup: pid, startTime: cached.startTime };
		// Cache miss is a one-time probe. Reconciliation does not use this path:
		// the footer would block on PowerShell for every cold PID.
		return queried();
	}
	// A refresh that misses must not answer with the previous creation time.
	return queried();
}

/**
 * Read a live process identity. `refresh` bypasses the Windows cache.
 * A kill uses probeWindowsStartTime, which notices the pid dying during the query.
 * Do not call refresh from a render or reconcile path: a cache miss blocks on PowerShell.
 */
export function readProcessIdentity(pid: number, options?: { refresh?: boolean }): ProcessIdentity | undefined {
	if (process.platform === "win32") return readWindowsProcessIdentity(pid, options?.refresh === true);
	if (process.platform !== "linux") return undefined;
	try {
		const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
		const close = stat.lastIndexOf(")");
		if (close < 0) return undefined;
		const fields = stat.slice(close + 2).trim().split(/\s+/);
		const processGroup = Number(fields[2]);
		const startTime = fields[19];
		if (!Number.isInteger(processGroup) || !startTime) return undefined;
		return { pid, processGroup, startTime };
	} catch {
		return undefined;
	}
}

/**
 * A recorded PID is only alive when the process still exists and, when a start
 * time was recorded, still refers to the same process. Without the start-time
 * check a recycled PID would keep a dead run looking active forever.
 */
export function isRecordedProcessAlive(record: AgentRecord): boolean {
	if (!record.pid || !isProcessAlive(record.pid)) {
		if (record.pid !== undefined && Number.isInteger(record.pid) && record.pid >= 1) forgetWindowsProcess(record.pid);
		return false;
	}
	if (!record.pidStartTime) return true;
	if (process.platform === "win32") {
		const cached = windowsStartTimeCache.get(record.pid);
		// A cached creation time that disagrees is a reused PID, even if the sample is old.
		if (cached && cached.startTime !== record.pidStartTime) return false;
		const fresh = !!cached && Date.now() - cached.fetchedAt < WINDOWS_IDENTITY_FRESH_MS;
		if (!fresh) refreshProcessIdentitySoon(record.pid);
		// Missing or stale agreement is not proof. Wait for a probe instead of marking the run dead.
		return true;
	}
	const identity = readProcessIdentity(record.pid);
	return !identity || identity.startTime === record.pidStartTime;
}

export function readRecords(agentDir: string): AgentRecord[] {
	const dir = registryDir(agentDir);
	if (!existsSync(dir)) return [];
	const records: AgentRecord[] = [];
	for (const name of readdirSync(dir)) {
		if (!name.endsWith(".json")) continue;
		try {
			const value: unknown = JSON.parse(readFileSync(join(dir, name), "utf8"));
			if (!isRecord(value)) continue;
			const marked = applyMarkers(value, readMarkers(agentDir, value));
			if (!TERMINAL.has(marked.status) && marked.pid && !isRecordedProcessAlive(marked)) {
				records.push(exitedRecord(marked));
			} else {
				records.push(marked);
			}
		} catch {
			// A malformed or half-cleaned record must not break the whole panel.
		}
	}
	return records;
}

interface CachedRecord { stamp: string; value: AgentRecord }
const recordCaches = new Map<string, Map<string, CachedRecord>>();
const snapshots = new Map<string, Promise<AgentRecord[]>>();

function recordCache(dir: string): Map<string, CachedRecord> {
	const key = resolve(dir);
	let cache = recordCaches.get(key);
	if (!cache) {
		cache = new Map();
		// Tests/session switches can visit many roots. Do not retain them indefinitely.
		if (recordCaches.size >= 8) recordCaches.delete(recordCaches.keys().next().value!);
		recordCaches.set(key, cache);
	}
	return cache;
}

function copyRecord(record: AgentRecord): AgentRecord {
	return { ...record, ...(record.usage ? { usage: { ...record.usage } } : {}), ...(record.tools ? { tools: [...record.tools] } : {}) };
}

async function cachedRecord(file: string, cache: Map<string, CachedRecord>): Promise<AgentRecord | undefined> {
	try {
		const info = await stat(file);
		const stamp = [info.dev, info.ino, info.size, info.mtimeMs, info.ctimeMs].join(":");
		const existing = cache.get(file);
		if (existing?.stamp === stamp) return copyRecord(existing.value);
		const value: unknown = JSON.parse(await readFile(file, "utf8"));
		if (!isRecord(value)) { cache.delete(file); return undefined; }
		cache.set(file, { stamp, value });
		return copyRecord(value);
	} catch {
		cache.delete(file);
		return undefined; // Malformed, concurrently removed, or temporarily unreadable.
	}
}

async function readRecordFiles(dir: string, names: readonly string[]): Promise<AgentRecord[]> {
	const files = names.filter((name) => name.endsWith(".json")).map((name) => join(dir, name));
	const paths = new Set(files);
	const cache = recordCache(dir);
	for (const file of cache.keys()) if (!paths.has(file)) cache.delete(file);
	const records = new Array<AgentRecord | undefined>(files.length);
	let next = 0;
	const readNext = async () => {
		while (next < files.length) {
			const index = next++;
			records[index] = await cachedRecord(files[index]!, cache);
		}
	};
	await Promise.all(Array.from({ length: Math.min(8, files.length) }, readNext));
	return records.filter((record): record is AgentRecord => record !== undefined);
}

async function readMarkersAsync(agentDir: string, record: AgentRecord, paths?: ReadonlySet<string>): Promise<RecordMarkers> {
	const present = async (file: string) => {
		if (paths) return paths.has(file);
		try { await stat(file); return true; } catch { return false; }
	};
	const cancelledPath = markerPath(agentDir, record.runId, "cancelled");
	let cancellation: CancellationMarker | undefined;
	if (await present(cancelledPath)) {
		let text = "";
		try { text = await readFile(cancelledPath, "utf8"); } catch { /* Existence remains authoritative. */ }
		cancellation = parseCancellationMarker(text, record.runId);
	}
	const flags = await Promise.all(RESULT_STATE_FLAGS.map(async (flag) => await present(resultStatePath(agentDir, record, flag)) ? flag : undefined));
	return { flags: flags.filter((flag): flag is ResultStateFlag => flag !== undefined), cancellation, closed: await present(closedPath(agentDir, record)) };
}

/** Exact-ID reads avoid walking every historical run for owner/lifecycle lookups. */
export function readRecord(agentDir: string, runId: string): AgentRecord | undefined {
	try {
		const value: unknown = JSON.parse(readFileSync(recordPath(agentDir, runId), "utf8"));
		if (!isRecord(value)) return undefined;
		const marked = applyMarkers(value, readMarkers(agentDir, value));
		return !TERMINAL.has(marked.status) && marked.pid && !isRecordedProcessAlive(marked) ? exitedRecord(marked) : marked;
	} catch { return undefined; }
}

export async function readRecordAsync(agentDir: string, runId: string): Promise<AgentRecord | undefined> {
	const value = await cachedRecord(recordPath(agentDir, runId), recordCache(registryDir(agentDir)));
	if (!value) return undefined;
	const marked = applyMarkers(value, await readMarkersAsync(agentDir, value));
	return !TERMINAL.has(marked.status) && marked.pid && !await isRecordedProcessAliveAsync(marked) ? exitedRecord(marked) : marked;
}

/** Nonblocking, single-flight snapshot shared by panel and waiters.
 * Unchanged response bodies are stat-validated, not reread/reparsed every poll.
 * Marker names and PID liveness are always refreshed, never frozen in the cache.
 */
export async function readRecordsAsync(agentDir: string): Promise<AgentRecord[]> {
	const dir = registryDir(agentDir);
	const key = resolve(dir);
	let snapshot = snapshots.get(key);
	if (!snapshot) {
		snapshot = (async () => {
			let names: string[];
			try { names = await readdir(dir); }
			catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
			const paths = new Set(names.map((name) => join(dir, name)));
			const records = await readRecordFiles(dir, names);
			let next = 0;
			const refreshNext = async () => {
				while (next < records.length) {
					const index = next++;
					const marked = applyMarkers(records[index]!, await readMarkersAsync(agentDir, records[index]!, paths));
					records[index] = TERMINAL.has(marked.status) || !marked.pid || await isRecordedProcessAliveAsync(marked) ? marked : exitedRecord(marked);
				}
			};
			await Promise.all(Array.from({ length: Math.min(8, records.length) }, refreshNext));
			return records;
		})();
		snapshots.set(key, snapshot);
		void snapshot.finally(() => { if (snapshots.get(key) === snapshot) snapshots.delete(key); }).catch(() => {});
	}
	return (await snapshot).map(copyRecord);
}

async function isRecordedProcessAliveAsync(record: AgentRecord): Promise<boolean> {
	// Read Linux /proc asynchronously; other platforms retain the existing nonblocking liveness check.
	if (process.platform !== "linux" || !record.pidStartTime) return isRecordedProcessAlive(record);
	if (!record.pid || !isProcessAlive(record.pid)) return false;
	try {
		const stat = await readFile(`/proc/${record.pid}/stat`, "utf8");
		const close = stat.lastIndexOf(")");
		if (close < 0) return true;
		const startTime = stat.slice(close + 2).trim().split(/\s+/)[19];
		return !startTime || startTime === record.pidStartTime;
	} catch {
		return true;
	}
}

function exitedRecord(record: AgentRecord): AgentRecord {
	return {
		...record,
		status: "failed",
		activity: "process exited unexpectedly",
		error: record.error ?? "Subagent process is no longer running",
	};
}

export function descendantsOf(records: readonly AgentRecord[], parentRunId: string): AgentRecord[] {
	const children = new Map<string, AgentRecord[]>();
	for (const record of records) {
		const list = children.get(record.parentRunId) ?? [];
		list.push(record);
		children.set(record.parentRunId, list);
	}
	for (const list of children.values()) {
		list.sort((a, b) => Date.parse(a.startedAt) - Date.parse(b.startedAt));
	}
	const result: AgentRecord[] = [];
	const visit = (parent: string) => {
		for (const child of children.get(parent) ?? []) {
			result.push(child);
			visit(child.runId);
		}
	};
	visit(parentRunId);
	return result;
}

/** Resolve exact identities first, then an unambiguous run-ID prefix. */
export function resolveAgentRecord(records: readonly AgentRecord[], target: string): AgentRecord {
	const value = target.trim();
	const exact = value ? records.filter((record) => record.runId === value || record.sessionId === value || record.name === value) : [];
	const matches = exact.length > 0 ? exact : value ? records.filter((record) => record.runId.startsWith(value)) : [];
	if (matches.length === 0) throw new Error(`No subagent matches "${value}".`);
	if (matches.length > 1) {
		throw new Error(`"${value}" is ambiguous; matches: ${matches.map((record) => `${record.name} (${record.runId})`).join(", ")}`);
	}
	return matches[0]!;
}

export function relativeDepths(records: readonly AgentRecord[], parentRunId: string): Map<string, number> {
	const depths = new Map<string, number>();
	const byParent = new Map<string, AgentRecord[]>();
	for (const record of records) {
		const list = byParent.get(record.parentRunId) ?? [];
		list.push(record);
		byParent.set(record.parentRunId, list);
	}
	const visit = (parent: string, depth: number) => {
		for (const child of byParent.get(parent) ?? []) {
			depths.set(child.runId, depth);
			visit(child.runId, depth + 1);
		}
	};
	visit(parentRunId, 0);
	return depths;
}
