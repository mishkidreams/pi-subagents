import { existsSync } from "node:fs";
import { readSessionBranch } from "./session-reader.ts";
import { setImmediate as yieldImmediate } from "node:timers/promises";
import {
	AssistantMessageComponent,
	SessionManager,
	ToolExecutionComponent,
	UserMessageComponent,
} from "@earendil-works/pi-coding-agent";
import { Text, type Component, type TUI, type TuiMouseEvent, type TuiMouseEventResult } from "@earendil-works/pi-tui";

export async function discoverSessionFile(cwd: string, sessionId: string): Promise<string | undefined> {
	try {
		return (await SessionManager.list(cwd)).find((session) => session.id === sessionId)?.path;
	} catch {
		return undefined;
	}
}

// A time slice alone cannot interrupt one enormous native Markdown/tool render.
// Oversized entries instead use bounded plain-text chunks, with no content loss.
const NATIVE_TEXT_BUDGET = 4096;
const SLICE_COMPONENTS = 16;
const SLICE_MS = 6;

function oversized(value: unknown): boolean {
	const pending = [value];
	let remaining = NATIVE_TEXT_BUDGET;
	let nodes = 128;
	while (pending.length) {
		if (--nodes < 0) return true;
		const item = pending.pop();
		if (typeof item === "string") remaining -= item.length;
		else if (item && typeof item === "object") {
			for (const key in item) {
				if (--nodes < 0) return true;
				remaining -= key.length;
				pending.push((item as Record<string, unknown>)[key]);
			}
		}
		if (remaining < 0) return true;
	}
	return false;
}

function userText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content.filter((part: any) => part?.type === "text" && typeof part?.text === "string").map((part: any) => part.text).join("\n");
}

function* textParts(content: unknown, thinking = false): Generator<string> {
	if (typeof content === "string") { yield content; return; }
	if (!Array.isArray(content)) return;
	for (const part of content) {
		if (part?.type === "text" && typeof part.text === "string") yield part.text;
		else if (thinking && part?.type === "thinking" && typeof part.thinking === "string") yield part.thinking;
		else if (part?.type === "image") yield "[image omitted]";
	}
}

/** Streaming argument presentation avoids JSON.stringify of multi-megabyte values. */
function* argumentParts(value: unknown): Generator<string> {
	function* members(object: object): Generator<[string, unknown]> {
		for (const key in object) yield [key, (object as Record<string, unknown>)[key]];
	}
	const initial: [string, unknown][] = [["", value]];
	const pending: Iterator<[string, unknown]>[] = [initial[Symbol.iterator]()];
	while (pending.length) {
		const next = pending[pending.length - 1].next();
		if (next.done) { pending.pop(); continue; }
		const [key, item] = next.value;
		if (key) yield `${key}:`;
		if (typeof item === "string") yield item;
		else if (item && typeof item === "object") pending.push(members(item));
		else yield String(item);
	}
}

class ChunkedText implements Component {
	constructor(private readonly label: string, private readonly parts: () => Iterable<string>) {}
	*chunks(): Generator<Component> {
		yield new Text(`[${this.label} · large payload shown as plain text]`, 0, 0);
		for (const text of this.parts()) {
			for (let start = 0; start < text.length;) {
				let end = Math.min(text.length, start + NATIVE_TEXT_BUDGET);
				if (end < text.length && /[\uD800-\uDBFF]/.test(text[end - 1])) end--;
				// Escape sequences split across chunks must never become terminal controls.
				yield new Text(text.slice(start, end).replace(/\x1b/g, "␛"), 0, 0);
				start = end;
			}
		}
	}
	render(): string[] { return [`[${this.label} · preparing large payload]`]; }
}

type CachedEntry = { component: Component; source: unknown; result?: unknown };
type RendererScope = { run<T>(operation: () => T): T; dispose(): void };
const SCOPE_FACTORY_KEY = Symbol.for("pi-compact-transcript.scope-factory");

/** Public optional protocol supplied by compact-transcript. Stock Pi needs no adapter. */
function rendererScope(): RendererScope {
	const factory = (globalThis as typeof globalThis & { [SCOPE_FACTORY_KEY]?: () => RendererScope })[SCOPE_FACTORY_KEY];
	return factory?.() ?? { run: operation => operation(), dispose() {} };
}

/** Yield once per historical entry so construction, not just layout, can be sliced. */
function* projectEntries(
	entries: readonly any[], tui: TUI, cwd: string, cache: Map<string, CachedEntry>,
	hideThinking: boolean, toolsExpanded: boolean, bind: (component: Component) => void,
): Generator<void, Component[]> {
	const items: CachedEntry[] = [];
	const pending = new Map<string, CachedEntry>();
	const kept = new Set<string>();
	const keep = (key: string, source: unknown, create: () => Component, update?: (component: Component) => void): CachedEntry => {
		kept.add(key);
		let item = cache.get(key);
		if (!item || (item.source !== source && !update)) {
			item = { component: create(), source };
			bind(item.component);
			cache.set(key, item);
		} else if (item.source !== source) {
			update!(item.component);
			item.source = source;
		}
		return item;
	};
	for (const entry of entries) {
		yield;
		try {
			const key = String(entry.id);
			if (entry.type === "compaction") {
				items.push(keep(key, entry, () => new Text(`— compacted ${entry.tokensBefore ?? "earlier"} tokens —`, 0, 0)));
			} else if (entry.type === "branch_summary") {
				const summary = typeof entry.summary === "string" ? entry.summary.slice(0, NATIVE_TEXT_BUDGET).split("\n")[0] : "branch summary";
				items.push(keep(key, entry, () => new Text(`— ${summary} —`, 0, 0)));
			} else if (entry.type === "custom_message") {
				if (entry.display) items.push(keep(key, entry, () => oversized(entry.content)
					? new ChunkedText("Custom message", () => textParts(entry.content)) : new Text(userText(entry.content), 1, 0)));
			} else if (entry.type === "message") {
				const message = entry.message;
				if (message?.role === "user") {
					items.push(keep(key, message, () => oversized(message.content)
						? new ChunkedText("User message", () => textParts(message.content)) : new UserMessageComponent(userText(message.content))));
				} else if (message?.role === "assistant") {
					let hasText = false;
					if (Array.isArray(message.content)) for (const part of message.content) {
						yield;
						if (part?.type === "text" || part?.type === "thinking") { hasText = true; break; }
					}
					if (hasText) {
						if (oversized(message.content)) {
							items.push(keep(`${key}:plain:${hideThinking}`, message, () => new ChunkedText("Assistant message", () => textParts(message.content, !hideThinking))));
						} else {
							items.push(keep(key, message, () => new AssistantMessageComponent(message, hideThinking), component => (component as AssistantMessageComponent).updateContent(message)));
						}
					}
					for (const [index, part] of (message.content ?? []).entries()) {
						yield;
						if (part?.type !== "toolCall") continue;
						const callKey = `${key}:call:${part.id ?? index}`;
						const item = keep(callKey, part, () => {
							if (oversized(part.arguments)) return new ChunkedText(`${part.name ?? "tool"} arguments`, () => argumentParts(part.arguments));
							const comp = new ToolExecutionComponent(part.name ?? "tool", part.id ?? callKey, part.arguments ?? {}, undefined, undefined, tui, cwd);
							comp.markExecutionStarted(); comp.setArgsComplete();
							if (toolsExpanded) comp.setExpanded(true);
							return comp;
						}, component => {
							if (component instanceof ToolExecutionComponent && !oversized(part.arguments)) component.updateArgs(part.arguments ?? {});
						});
						if (part.id) pending.set(part.id, item);
						items.push(item);
					}
				} else if (message?.role === "toolResult") {
					const item = message.toolCallId ? pending.get(message.toolCallId) : undefined;
					if (item) {
						if (item.result !== message) {
							if (oversized(message.content) || oversized(message.details) || item.component instanceof ChunkedText) {
								const call = item.source as any;
								item.component = new ChunkedText(`${call.name ?? "tool"} call and result`, function* () {
									yield "Arguments"; yield* argumentParts(call.arguments ?? {});
									yield "Result"; yield* textParts(message.content);
								});
							} else {
								(item.component as ToolExecutionComponent).updateResult({ content: message.content ?? [], details: message.details, isError: !!message.isError });
							}
							item.result = message;
						}
						pending.delete(message.toolCallId);
					}
				}
			}
		} catch { /* A malformed historical entry must not hide its neighbours. */ }
	}
	// A branch can retain a call while abandoning its former result.
	for (const item of pending.values()) {
		if (item.result !== undefined) {
			for (const [key, cached] of cache) if (cached === item) cache.delete(key);
		}
	}
	for (const key of cache.keys()) if (!kept.has(key)) cache.delete(key);
	return items.map(item => item.component);
}

/** Legacy synchronous projection for existing callers; the interactive panel uses update(). */
export function buildTranscript(sessionFile: string, tui: TUI, cwd: string): Component[] | null {
	if (!existsSync(sessionFile)) return null;
	try {
		const projection = projectEntries(SessionManager.open(sessionFile, undefined, cwd).getBranch(), tui, cwd, new Map(), false, false, () => {});
		let next = projection.next();
		while (!next.done) next = projection.next();
		return next.value;
	} catch { return null; }
}

type LayoutEntry = { component: Component; top: number; height: number };

/** Async preparation, bounded native payloads, and cached cleaned layout for one open child. */
export class TranscriptView implements Component {
	private scope = rendererScope();
	private readonly cache = new Map<string, CachedEntry>();
	private entries?: readonly any[];
	private components: Component[] = [];
	private file?: string;
	private toolsExpanded = false;
	private hideThinking = true;
	private disposed = false;
	private generation = 0;
	private layoutGeneration = 0;
	private layout?: { width: number; generation: number; lines: string[]; entries: LayoutEntry[] };
	private updating?: Promise<boolean>;
	private disclosure?: Promise<void>;
	private toolRequests = 0;
	private thinkingRequests = 0;
	private appliedTools = 0;
	private appliedThinking = 0;
	private preparing?: { width: number; generation: number; promise: Promise<void> };
	private invalidated = false;
	private renderingComponent = false;
	private layoutTicket = 0;
	private requestedWidth?: number;

	constructor(private readonly tui: TUI, private readonly cwd: string) {}

	update(sessionFile: string): Promise<boolean> {
		if (this.disposed) return Promise.resolve(false);
		if (this.updating && this.file === sessionFile) return this.updating;
		if (this.file && this.file !== sessionFile) this.reset();
		this.file = sessionFile;
		const generation = this.generation;
		const pending = (async () => {
			try {
				const entries = await readSessionBranch(sessionFile, this.cwd);
				if (this.disposed || generation !== this.generation) return false;
				if (entries === this.entries) { this.queueDisclosure(); return true; }
				await this.project(entries, generation);
				if (this.disposed || generation !== this.generation) return false;
				this.entries = entries;
				this.queueDisclosure();
				this.dirty();
				this.tui.requestRender();
				return true;
			} catch { return false; }
		})().finally(() => { if (this.updating === pending) this.updating = undefined; });
		this.updating = pending;
		return pending;
	}

	private async project(entries: readonly any[], generation: number): Promise<void> {
		const previous = new Map(Array.from(this.cache, ([key, item]) => [key, item.component]));
		const build = () => projectEntries(entries, this.tui, this.cwd, this.cache, this.hideThinking, this.toolsExpanded, component => {
			const scope = this.scope;
			const invalidate = component.invalidate?.bind(component);
			if (invalidate) component.invalidate = () => {
				scope.run(invalidate);
				if (!this.disposed && this.scope === scope && !this.renderingComponent) this.dirty();
			};
		});
		const run = async () => {
			const projection = build();
			let deadline = Date.now() + SLICE_MS;
			for (let count = 0;; count++) {
				if (this.disposed || generation !== this.generation) return [];
				const next = this.scope.run(() => projection.next());
				if (next.done) return next.value;
				if (count % SLICE_COMPONENTS === 0 || Date.now() >= deadline) {
					await yieldImmediate(); deadline = Date.now() + SLICE_MS;
				}
			}
		};
		let components = await run();
		if (this.disposed || generation !== this.generation) return;
		if (Array.from(previous).some(([key, component]) => this.cache.get(key)?.component !== component)) {
			this.scope.dispose(); this.scope = rendererScope(); this.cache.clear();
			components = await run();
		}
		if (!this.disposed && generation === this.generation) this.components = components;
	}

	private dirty(): void { this.layoutGeneration++; }

	private *layoutComponents(): Generator<Component> {
		for (const component of this.components) {
			if (component instanceof ChunkedText) yield* component.chunks();
			else yield component;
		}
	}

	private renderComponent(component: Component, width: number): string[] {
		return this.scope.run(() => {
			this.renderingComponent = true;
			try {
				if (this.invalidated) component.invalidate?.();
				return component.render(width);
			} catch { return ["[Unable to display this historical entry]"]; }
			finally { this.renderingComponent = false; }
		});
	}

	private prepare(width: number): void {
		const generation = this.layoutGeneration;
		if (this.preparing?.width === width && this.preparing.generation === generation) return;
		const ticket = ++this.layoutTicket;
		// At most four bounded native payloads; keeps small disclosure clicks immediate.
		if (this.components.length <= 4 && !this.components.some(component => component instanceof ChunkedText)) {
			const lines: string[] = [], entries: LayoutEntry[] = [];
			for (const component of this.components) {
				const rendered = this.renderComponent(component, width);
				entries.push({ component, top: lines.length, height: rendered.length });
				for (const line of rendered) lines.push(line.replace(/\x1b\][^\x07]*\x07/g, ""));
			}
			this.layout = { width, generation, lines, entries };
			this.invalidated = false;
			return;
		}
		const prepare = async () => {
			await yieldImmediate();
			const lines: string[] = [];
			const entries: LayoutEntry[] = [];
			let deadline = Date.now() + SLICE_MS;
			let count = 0;
			for (const component of this.layoutComponents()) {
				if (this.disposed || generation !== this.layoutGeneration || ticket !== this.layoutTicket) return;
				const rendered = this.renderComponent(component, width);
				entries.push({ component, top: lines.length, height: rendered.length });
				for (const line of rendered) lines.push(line.replace(/\x1b\][^\x07]*\x07/g, ""));
				if (++count % SLICE_COMPONENTS === 0 || Date.now() >= deadline) {
					await yieldImmediate(); deadline = Date.now() + SLICE_MS;
				}
			}
			if (!this.disposed && generation === this.layoutGeneration && ticket === this.layoutTicket) {
				this.layout = { width, generation, lines, entries };
				this.invalidated = false;
				this.tui.requestRender();
			}
		};
		const promise = prepare().finally(() => {
			if (this.preparing?.promise === promise) this.preparing = undefined;
		});
		this.preparing = { width, generation, promise };
	}

	async ready(): Promise<void> {
		while (!this.disposed) {
			await this.updating;
			await this.disclosure;
			const width = this.requestedWidth;
			if (width !== undefined && (this.layout?.width !== width || this.layout.generation !== this.layoutGeneration)) this.prepare(width);
			await this.preparing?.promise;
			if (!this.updating && !this.disclosure && !this.preparing && (width === undefined || (this.layout?.width === width && this.layout.generation === this.layoutGeneration))) return;
		}
	}

	toggleTools(): void { this.toolsExpanded = !this.toolsExpanded; this.toolRequests++; this.queueDisclosure(); }

	toggleThinking(): void { this.hideThinking = !this.hideThinking; this.thinkingRequests++; this.queueDisclosure(); }

	private queueDisclosure(): void {
		if (this.disclosure || this.disposed || (this.toolRequests === this.appliedTools && this.thinkingRequests === this.appliedThinking)) return;
		const generation = this.generation;
		const pending = (async () => {
			let appliedTools = this.appliedTools, appliedThinking = this.appliedThinking;
			for (;;) {
				await yieldImmediate();
				const tools = this.toolRequests, thinking = this.thinkingRequests;
				const expanded = this.toolsExpanded, hidden = this.hideThinking;
				let count = 0, deadline = Date.now() + SLICE_MS;
				for (const component of this.components) {
					if (this.disposed || generation !== this.generation) return;
					this.scope.run(() => {
						if (tools !== appliedTools && component instanceof ToolExecutionComponent) component.setExpanded(expanded);
						if (thinking !== appliedThinking && component instanceof AssistantMessageComponent) component.setHideThinkingBlock(hidden);
					});
					if (++count % SLICE_COMPONENTS === 0 || Date.now() >= deadline) { await yieldImmediate(); deadline = Date.now() + SLICE_MS; }
				}
				if (thinking !== appliedThinking && this.entries) await this.project(this.entries, generation);
				if (this.disposed || generation !== this.generation) return;
				this.dirty(); this.tui.requestRender();
				this.appliedTools = appliedTools = tools; this.appliedThinking = appliedThinking = thinking;
				if (tools === this.toolRequests && thinking === this.thinkingRequests) return;
			}
		})().finally(() => { if (this.disclosure === pending) this.disclosure = undefined; });
		this.disclosure = pending;
	}

	render(width: number): string[] {
		if (this.disposed) return [];
		// Optional renderer scopes detect configuration/theme changes on entry.
		this.scope.run(() => {});
		this.requestedWidth = width;
		if (this.layout?.width !== width || this.layout.generation !== this.layoutGeneration) this.prepare(width);
		return this.layout?.width === width ? this.layout.lines : ["Preparing transcript…"];
	}

	handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
		if (!this.layout || this.layout.width !== event.width) return undefined;
		const entries = this.layout.entries;
		let lo = 0, hi = entries.length;
		while (lo < hi) {
			const mid = (lo + hi) >>> 1;
			if (entries[mid].top + entries[mid].height <= event.y) lo = mid + 1; else hi = mid;
		}
		const item = entries[lo];
		if (!item || event.y < item.top) return undefined;
		const result = this.scope.run(() => item.component.handleMouse?.({ ...event, y: event.y - item.top, height: item.height }));
		if (result) this.dirty();
		return result;
	}

	invalidate(): void { this.invalidated = true; this.dirty(); }

	/** Stop queued projection/layout work while retaining a bounded recent view. */
	pause(): void { this.generation++; this.layoutTicket++; this.updating = undefined; this.preparing = undefined; this.disclosure = undefined; }

	private reset(): void {
		this.generation++; this.dirty();
		this.scope.dispose();
		if (!this.disposed) this.scope = rendererScope();
		this.cache.clear();
		this.entries = undefined; this.components = []; this.layout = undefined;
	}

	dispose(): void { this.disposed = true; this.reset(); }
}
