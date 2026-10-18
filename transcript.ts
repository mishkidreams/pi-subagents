import { existsSync } from "node:fs";
import {
	AssistantMessageComponent,
	SessionManager,
	ToolExecutionComponent,
	UserMessageComponent,
} from "@earendil-works/pi-coding-agent";
import { Container, Text, type Component, type TUI, type TuiMouseEvent, type TuiMouseEventResult } from "@earendil-works/pi-tui";

export async function discoverSessionFile(cwd: string, sessionId: string): Promise<string | undefined> {
	try {
		return (await SessionManager.list(cwd)).find((session) => session.id === sessionId)?.path;
	} catch {
		return undefined;
	}
}

function userText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter((part: any) => part?.type === "text" && typeof part?.text === "string")
		.map((part: any) => part.text)
		.join("\n");
}

function hasVisibleAssistantContent(message: any): boolean {
	return Array.isArray(message?.content) && message.content.some((part: any) => part?.type === "text" || part?.type === "thinking");
}

type CachedEntry = { component: Component; source: string; result?: string };
type RendererScope = { run<T>(operation: () => T): T; dispose(): void };
const SCOPE_FACTORY_KEY = Symbol.for("pi-compact-transcript.scope-factory");

/** Public optional protocol supplied by compact-transcript. Stock Pi needs no adapter. */
function rendererScope(): RendererScope {
	const factory = (globalThis as typeof globalThis & { [SCOPE_FACTORY_KEY]?: () => RendererScope })[SCOPE_FACTORY_KEY];
	return factory?.() ?? { run: operation => operation(), dispose() {} };
}

/** Complete active branch, including entries before compaction. No model context or session writes. */
function buildComponents(
	sessionFile: string, tui: TUI, cwd: string,
	cache = new Map<string, CachedEntry>(), hideThinking = false, toolsExpanded = false,
	bind?: (component: Component) => void,
): Component[] | null {
	if (!existsSync(sessionFile)) return null;
	let entries: any[];
	try {
		entries = SessionManager.open(sessionFile, undefined, cwd).getBranch();
	} catch {
		return null;
	}
	const components: Component[] = [];
	const pending = new Map<string, CachedEntry>();
	const resultIds = new Set(entries.filter(entry => entry.type === "message" && entry.message?.role === "toolResult").map(entry => entry.message.toolCallId));
	const kept = new Set<string>();
	const keep = (key: string, source: unknown, create: () => Component, update?: (component: Component) => void): CachedEntry => {
		kept.add(key);
		const serialized = JSON.stringify(source);
		let item = cache.get(key);
		if (!item || (item.source !== serialized && !update)) {
			item = { component: create(), source: serialized };
			bind?.(item.component);
			cache.set(key, item);
		} else if (item.source !== serialized) {
			update!(item.component);
			item.source = serialized;
		}
		return item;
	};
	for (const entry of entries) {
		try {
			const key = String(entry.id);
			if (entry.type === "compaction") {
				components.push(keep(key, entry, () => new Text(`— compacted ${entry.tokensBefore ?? "earlier"} tokens —`, 0, 0)).component);
				continue;
			}
			if (entry.type === "branch_summary") {
				const summary = typeof entry.summary === "string" ? entry.summary.split("\n")[0] : "branch summary";
				components.push(keep(key, entry, () => new Text(`— ${summary} —`, 0, 0)).component);
				continue;
			}
			if (entry.type === "custom_message") {
				const text = userText(entry.content);
				if (entry.display && text.trim()) components.push(keep(key, entry, () => new Text(text, 1, 0)).component);
				continue;
			}
			if (entry.type !== "message") continue;
			const message = entry.message;
			if (message?.role === "user") {
				const text = userText(message.content);
				if (text.trim()) components.push(keep(key, message, () => new UserMessageComponent(text)).component);
			} else if (message?.role === "assistant") {
				if (hasVisibleAssistantContent(message)) {
					components.push(keep(key, message, () => new AssistantMessageComponent(message, hideThinking), component => (component as AssistantMessageComponent).updateContent(message)).component);
				}
				for (const [index, part] of (message.content ?? []).entries()) {
					if (part?.type !== "toolCall") continue;
					const callKey = `${key}:call:${part.id ?? index}`;
					// A branch may retain a call but no longer contain its old result.
					if (!resultIds.has(part.id) && cache.get(callKey)?.result !== undefined) cache.delete(callKey);
					const item = keep(callKey, part, () => {
						const comp = new ToolExecutionComponent(part.name ?? "tool", part.id ?? callKey, part.arguments ?? {}, undefined, undefined, tui, cwd);
						comp.markExecutionStarted();
						comp.setArgsComplete();
						if (toolsExpanded) comp.setExpanded(true);
						return comp;
					}, component => (component as ToolExecutionComponent).updateArgs(part.arguments ?? {}));
					if (part.id) pending.set(part.id, item);
					components.push(item.component);
				}
			} else if (message?.role === "toolResult") {
				const item = message.toolCallId ? pending.get(message.toolCallId) : undefined;
				if (item) {
					try {
						const serialized = JSON.stringify(message);
						if (item.result !== serialized) {
							(item.component as ToolExecutionComponent).updateResult({ content: message.content ?? [], details: message.details, isError: !!message.isError });
							item.result = serialized;
						}
					} catch {
						// Keep the call rendering if a historical result shape changed.
					}
					pending.delete(message.toolCallId);
				}
			}
		} catch {
			// One bad historical entry must not hide the rest of the transcript.
		}
	}
	for (const key of cache.keys()) if (!kept.has(key)) cache.delete(key);
	return components;
}

/** Legacy stateless projection. Interactive viewers use TranscriptView below. */
export function buildTranscript(sessionFile: string, tui: TUI, cwd: string): Component[] | null {
	return buildComponents(sessionFile, tui, cwd);
}

/** Owns native disclosure, hit-testing and optional compact state for one child.
 * Unchanged native components survive JSONL appends, preserving local click overrides.
 */
export class TranscriptView implements Component {
	private readonly root = new Container();
	private scope = rendererScope();
	private readonly cache = new Map<string, CachedEntry>();
	private file?: string;
	private toolsExpanded = false;
	private hideThinking = true;

	constructor(private readonly tui: TUI, private readonly cwd: string) {}

	update(sessionFile: string): boolean {
		if (this.file && this.file !== sessionFile) {
			this.scope.dispose();
			this.scope = rendererScope();
			this.cache.clear();
		}
		this.file = sessionFile;
		const previous = new Map(Array.from(this.cache, ([key, entry]) => [key, entry.component]));
		const build = () => {
			const scope = this.scope;
			return buildComponents(sessionFile, this.tui, this.cwd, this.cache, this.hideThinking, this.toolsExpanded, component => {
				// Native image/render-context callbacks may invalidate after dispatch has
				// returned. Capture this component's original scope, even after branch reset.
				const invalidate = component.invalidate?.bind(component);
				if (invalidate) component.invalidate = () => scope.run(invalidate);
			});
		};
		let components = this.scope.run(build);
		if (!components) return false;
		// Append preserves local disclosure; replacing/removing old branch entries must
		// not retain a compact group owner or hidden members from the abandoned branch.
		if (Array.from(previous).some(([key, component]) => this.cache.get(key)?.component !== component)) {
			this.scope.dispose();
			this.scope = rendererScope();
			this.cache.clear();
			components = this.scope.run(build);
			if (!components) return false;
		}
		this.root.clear();
		for (const component of components) this.root.addChild(component);
		return true;
	}

	toggleTools(): void {
		this.toolsExpanded = !this.toolsExpanded;
		this.scope.run(() => {
			for (const component of this.root.children) if (component instanceof ToolExecutionComponent) component.setExpanded(this.toolsExpanded);
		});
	}

	toggleThinking(): void {
		this.hideThinking = !this.hideThinking;
		this.scope.run(() => {
			for (const component of this.root.children) if (component instanceof AssistantMessageComponent) component.setHideThinkingBlock(this.hideThinking);
		});
	}

	render(width: number): string[] { return this.scope.run(() => this.root.render(width)); }
	handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined { return this.scope.run(() => this.root.handleMouse(event)); }
	invalidate(): void { this.scope.run(() => this.root.invalidate()); }
	dispose(): void { this.root.clear(); this.cache.clear(); this.scope.dispose(); }
}
