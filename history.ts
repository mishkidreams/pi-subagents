import { createHash } from "node:crypto";
import { closeSync, openSync, readSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { CURRENT_SESSION_VERSION, SessionManager } from "@earendil-works/pi-coding-agent";
import type { AgentRecord } from "./types.ts";
import { readConversationPageAsync } from "./session-reader.ts";

type ConversationMessage = { id: string; role: "user" | "assistant"; text: string; continued?: boolean };

function isObject(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object";
}

function chatMessage(entry: unknown): ConversationMessage | undefined {
	if (!isObject(entry) || entry.type !== "message" || typeof entry.id !== "string" || !isObject(entry.message)) return;
	const { role, content } = entry.message;
	if (role !== "user" && role !== "assistant") return;
	const parts: string[] = [];
	if (typeof content === "string") parts.push(content);
	else if (Array.isArray(content)) {
		for (const part of content) {
			if (!isObject(part)) continue;
			if (part.type === "text" && typeof part.text === "string") parts.push(part.text);
			else if (part.type === "image") parts.push("[image omitted]");
		}
	}
	const text = parts.join("\n");
	if (text) return { id: entry.id, role, text };
}

function headerError(): Error {
	return new Error("Child session header is missing or malformed; verify the child's saved session file.");
}

function parseHeader(line: string): unknown {
	try { return JSON.parse(line); } catch { throw headerError(); }
}

/** Preflight before open(), which otherwise creates empty sessions or migrates files. */
function readHeader(sessionFile: string): unknown {
	const fd = openSync(sessionFile, "r");
	try {
		const decoder = new StringDecoder("utf8");
		const buffer = Buffer.allocUnsafe(4096);
		let pending = "";
		const maximum = 1024 * 1024;
		for (let scanned = 0; scanned < maximum;) {
			const count = readSync(fd, buffer, 0, Math.min(buffer.length, maximum - scanned), null);
			pending += count ? decoder.write(buffer.subarray(0, count)) : decoder.end();
			let newline: number;
			while ((newline = pending.indexOf("\n")) !== -1) {
				const line = pending.slice(0, newline);
				pending = pending.slice(newline + 1);
				if (line.trim()) return parseHeader(line);
			}
			if (!count) {
				if (pending.trim()) return parseHeader(pending);
				throw headerError();
			}
			scanned += count;
		}
		throw new Error("Child session header exceeds the 1 MiB inspection limit.");
	} finally { closeSync(fd); }
}

function normalizedPath(value: string): string {
	const path = resolve(value);
	return process.platform === "win32" ? path.toLowerCase() : path;
}

function validateHeader(header: unknown, record: AgentRecord): void {
	if (!isObject(header) || header.type !== "session" || typeof header.id !== "string" || !header.id ||
		typeof header.cwd !== "string" || !isAbsolute(header.cwd)) throw headerError();
	if (header.id !== record.sessionId) throw new Error("Child session identity does not match its saved record; verify the session file.");
	if (normalizedPath(header.cwd) !== normalizedPath(record.cwd)) throw new Error("Child session cwd does not match its saved record; verify the session file.");
	if (header.version !== CURRENT_SESSION_VERSION) {
		throw new Error("Child session version requires migration or a compatible Pi version; inspection will not migrate history.");
	}
}

function bound(value: number | undefined, fallback: number, maximum: number): number {
	if (typeof value !== "number" || Number.isNaN(value)) return fallback;
	return Math.min(maximum, Math.max(1, Math.floor(value)));
}

type Position = { id: string | null; offset: number };

function cursorError(reason: string): Error {
	return new Error(`Invalid conversation cursor (${reason}). Reset by omitting cursor in readConversation (tool callers: set fromStart:true) to read the active branch from the start.`);
}

function decodeCursor(cursor: string, source: string): Position {
	try {
		if (typeof cursor !== "string" || cursor.length > 4096 || !/^[A-Za-z0-9_-]+$/.test(cursor)) throw cursorError("invalid encoding");
		const buffer = Buffer.from(cursor, "base64url");
		if (buffer.toString("base64url") !== cursor) throw cursorError("invalid encoding");
		const value: unknown = JSON.parse(buffer.toString("utf8"));
		if (!Array.isArray(value) || value.length !== 4 || value[0] !== 1 || value[1] !== source ||
			(value[2] !== null && (typeof value[2] !== "string" || !value[2])) ||
			!Number.isSafeInteger(value[3]) || value[3] < 0 || (value[2] === null && value[3] !== 0)) {
			throw cursorError("invalid position or different child session");
		}
		return { id: value[2], offset: value[3] };
	} catch {
		throw cursorError("malformed token or different child session");
	}
}

export type ConversationOptions = { cursor?: string; limit?: number; maxChars?: number };
export type ConversationResult = { messages: ConversationMessage[]; nextCursor?: string; hasMore: boolean };

function validateRecord(record: AgentRecord): asserts record is AgentRecord & { sessionFile: string; sessionId: string } {
	if (!record.sessionFile) throw new Error("Child has no saved session file.");
	if (!isAbsolute(record.sessionFile) || !record.sessionId || !isAbsolute(record.cwd)) {
		throw new Error("Child session record needs an absolute session file/cwd and a session identity.");
	}
}

function cursorSource(record: AgentRecord): string {
	return createHash("sha256").update(JSON.stringify([record.sessionId, normalizedPath(record.sessionFile!), normalizedPath(record.cwd)])).digest("base64url");
}

/** Fully async interactive reader: bounded IO, off-thread parse, append-offset cache. */
export async function readConversationAsync(record: AgentRecord, options: ConversationOptions = {}): Promise<ConversationResult> {
	validateRecord(record);
	const source = cursorSource(record);
	const position = options.cursor === undefined ? { id: null, offset: 0 } : decodeCursor(options.cursor, source);
	const page = await readConversationPageAsync(record.sessionFile, { sessionId: record.sessionId, cwd: record.cwd }, position,
		bound(options.limit, 20, 100), bound(options.maxChars, 24000, 50000));
	return {
		messages: page.messages,
		nextCursor: Buffer.from(JSON.stringify([1, source, page.position.id, page.position.offset])).toString("base64url"),
		hasMore: page.hasMore,
	};
}

/**
 * Legacy synchronous compatibility API; interactive tools use readConversationAsync.
 * Read the complete active branch, including pre-compaction delegation. Output
 * contains only user/assistant text and image placeholders, never tool/thinking
 * payloads. continued means this chunk starts inside a previously read message.
 * Bounds count UTF-16 text code units. Keep nextCursor even when hasMore is false
 * for later delta reads; omit cursor to start over after a branch change. Saved
 * headers must match the record's identity/cwd and the installed session version;
 * inspection never creates missing sessions or migrates legacy history.
 */
export function readConversation(
	record: AgentRecord,
	options: ConversationOptions = {},
): ConversationResult {
	validateRecord(record);
	validateHeader(readHeader(record.sessionFile), record);
	const session = SessionManager.open(record.sessionFile, undefined, record.cwd);
	validateHeader(session.getHeader(), record);
	const branch = session.getBranch();
	const source = cursorSource(record);
	let position: Position = options.cursor === undefined ? { id: null, offset: 0 } : decodeCursor(options.cursor, source);
	const start = position.id === null ? 0 : branch.findIndex((entry) => entry.id === position.id);
	if (start < 0) throw cursorError("entry is no longer on the active branch");
	const chat = branch.map(chatMessage);
	if (position.offset > (chat[start]?.text.length ?? 0)) throw cursorError("text offset is out of range");
	const limit = bound(options.limit, 20, 100);
	let remaining = bound(options.maxChars, 24000, 50000);
	const messages: ConversationMessage[] = [];
	let hasMore = false;
	for (let i = start; i < branch.length; i++) {
		const message = chat[i];
		const offset = i === start ? position.offset : 0;
		if (!message || offset === message.text.length) {
			position = { id: branch[i].id, offset: message?.text.length ?? 0 };
			continue;
		}
		if (messages.length >= limit || remaining <= 0) { hasMore = true; break; }
		const text = message.text.slice(offset, offset + remaining);
		messages.push({ ...message, text, ...(offset > 0 ? { continued: true } : {}) });
		remaining -= text.length;
		position = { id: message.id, offset: offset + text.length };
		if (position.offset < message.text.length) { hasMore = true; break; }
	}
	return { messages, nextCursor: Buffer.from(JSON.stringify([1, source, position.id, position.offset])).toString("base64url"), hasMore };
}
