import { statSync, watch, type FSWatcher } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, relative, sep } from "node:path";
import type { Theme } from "@earendil-works/pi-coding-agent";
import {
	Input,
	getKeybindings,
	Key,
	matchesKey,
	truncateToWidth,
	type Component,
	type Focusable,
	type OverlayHandle,
	type TUI,
	type TuiMouseEvent,
	type TuiMouseEventResult,
	visibleWidth,
	wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import { descendantsOf, isTerminalStatus, markRecordResultState, readRecords, readRecordsAsync, registryDir } from "./registry.ts";
import { TranscriptView, discoverSessionFile } from "./transcript.ts";
import { TranscriptViewport } from "./transcript-viewport.ts";
import type { AgentRecord } from "./types.ts";

const MAX_FOOTER_ROWS = 8;
const MAX_TRANSCRIPT_LINES = 150;
const SCROLL_STEP = 5;
const SCROLL_PAGE = 20;
const OVERLAY_MARGIN = 0;
const REGISTRY_DEBOUNCE_MS = 30;
const REGISTRY_POLL_MS = 1000;
const COPY_FEEDBACK_MS = 2000;

interface SubagentPanelOptions {
	onMessage?: (record: AgentRecord, text: string) => Promise<void>;
	onCancel?: (record: AgentRecord) => void;
	onCopyPath?: (path: string) => Promise<void>;
}

interface DetailState {
	input: Input;
	draft: string;
	revision: number;
	viewport: TranscriptViewport;
	sending: boolean;
	status?: string;
	error?: boolean;
	copying?: boolean;
	copyStatus?: string;
	copyError?: boolean;
	copyFeedbackTimer?: ReturnType<typeof setTimeout>;
	transcript?: { key: string; view: TranscriptView };
}

function shortPath(path: string): string {
	const suffix = relative(homedir(), path);
	if (!suffix) return "~";
	return suffix !== ".." && !suffix.startsWith(`..${sep}`) && !isAbsolute(suffix)
		? `~/${suffix.split(sep).join("/")}`
		: path;
}

function elapsed(record: AgentRecord): string {
	const end = record.finishedAt ? Date.parse(record.finishedAt) : Date.now();
	const seconds = Math.max(0, Math.floor((end - Date.parse(record.startedAt)) / 1000));
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	return minutes < 60 ? `${minutes}m` : `${Math.floor(minutes / 60)}h`;
}

export function isTerminal(record: AgentRecord): boolean {
	return isTerminalStatus(record.status);
}

function statusIcon(record: AgentRecord): string {
	switch (record.status) {
		case "completed":
			return "✓";
		case "failed":
			return "✗";
		case "cancelled":
			return "✗";
		case "idle":
			return "◐";
		case "queued":
			return "◌";
		default:
			return "●";
	}
}

function statusColor(record: AgentRecord): "success" | "error" | "warning" | "accent" {
	if (record.status === "completed") return "success";
	if (record.status === "failed" || record.status === "cancelled") return "error";
	if (record.status === "idle") return "warning";
	return "accent";
}

/** Strip OSC control sequences (e.g. semantic-prompt markers) that would skew width math. */
function clean(line: string): string {
	return line.replace(/\][^\x07]*\x07/g, "");
}

export class SubagentPanel implements Component, Focusable {
	private _focused = false;
	private records: AgentRecord[] = [];
	private visible: AgentRecord[] = [];
	private selected = 0;
	private detail = false;
	private reviewing = false;
	private editor?: Component;
	private mainModel?: string;
	private transcriptFile?: string;
	private lastDiscover = 0;
	private detailRunId?: string;
	private detailStates = new Map<string, DetailState>();
	private messageInput = new Input();
	private detailGeometry?: {
		width: number; bodyTop: number; bodyHeight: number; inputY: number; controlsY: number;
		pathY?: number; pathStart: number; pathEnd: number; cwd: string;
		buttons: { start: number; end: number; action: "back" | "start" | "latest" }[];
	};
	private draggingScrollbar = false;
	private pressedDetailButton?: "back" | "start" | "latest";
	private pressedPath?: { runId: string; path: string };
	private detailOverlay?: SubagentDetailOverlay;
	private overlayHandle?: OverlayHandle;
	private timer: ReturnType<typeof setInterval>;
	private watcher?: FSWatcher;
	private refreshTimer?: ReturnType<typeof setTimeout>;
	private refreshing = false;
	private refreshQueued = false;
	private refreshVersion = 0;
	private disposed = false;

	get focused(): boolean {
		return this._focused;
	}

	set focused(value: boolean) {
		this._focused = value;
		this.messageInput.focused = value && this.detail;
	}

	constructor(
		private readonly tui: TUI,
		private theme: Theme,
		private readonly agentDir: string,
		private readonly currentRunId: string,
		private readonly options: SubagentPanelOptions = {},
	) {
		this.messageInput.onSubmit = (value) => {
			const text = value.trim();
			const record = this.rows()[this.selected];
			if (!text || !record || !this.options.onMessage) return;
			const state = this.stateFor(record.runId);
			if (state.sending) return;
			state.draft = value;
			const revision = state.revision;
			state.sending = true;
			this.clearCopyFeedback(state);
			state.error = false;
			state.status = "Sending…";
			state.viewport.scrollToEnd();
			this.tui.requestRender();
			// Freeze the recipient. Esc/reordering/switching children never retargets a send.
			void Promise.resolve().then(() => this.options.onMessage!(record, text)).then(
				() => {
					state.sending = false;
					state.status = "Sent";
					if (state.revision === revision) {
						state.draft = "";
						state.input.setValue("");
					}
					if (!this.disposed) this.tui.requestRender();
				},
				(error) => {
					state.sending = false;
					this.clearCopyFeedback(state);
					state.error = true;
					state.status = `Send failed: ${error instanceof Error ? error.message : String(error)} · Enter retry`;
					if (!this.disposed) this.tui.requestRender();
				},
			);
		};
		this.refresh();
		this.watchRegistry();
		this.timer = setInterval(() => {
			this.watchRegistry();
			void this.refreshAsync();
		}, REGISTRY_POLL_MS);
		this.timer.unref?.();
	}

	setEditor(editor: Component): void {
		this.editor = editor;
	}

	setTheme(theme: Theme): void {
		this.theme = theme;
	}

	setMainModel(model: string | undefined): void {
		this.mainModel = model;
	}

	/** Hide finished subagents from the footer. Runs when the user starts a new turn. */
	dismissFinished(): number {
		this.refresh();
		let count = 0;
		for (const record of this.records) {
			if (!isTerminal(record) || record.footerDismissed) continue;
			try {
				markRecordResultState(this.agentDir, record, "footerDismissed");
				count++;
			} catch {
				// One bad write must not block the rest.
			}
		}
		if (count > 0) this.refresh();
		return count;
	}

	/** Down-arrow entry: only non-dismissed subagents. */
	open(): boolean {
		if (this.overlayHandle) this.closeDetail();
		this.refresh();
		if (this.visible.length === 0) return false;
		this.reviewing = false;
		this.detail = false;
		this.selected = Math.min(this.selected, this.visible.length - 1);
		this.tui.setFocus(this);
		this.tui.requestRender();
		return true;
	}

	/** /subagents entry: full history including dismissed. */
	openReview(): boolean {
		if (this.overlayHandle) this.closeDetail();
		this.refresh();
		if (this.records.length === 0) return false;
		this.reviewing = true;
		this.detail = false;
		this.selected = Math.min(this.selected, this.records.length - 1);
		this.tui.setFocus(this);
		this.tui.requestRender();
		return true;
	}

	private rows(): AgentRecord[] {
		return this.reviewing ? this.records : this.visible;
	}

	private selectedRecord(): AgentRecord | undefined {
		return this.rows()[this.selected];
	}

	private close(): void {
		this.detail = false;
		this.messageInput.focused = false;
		this.reviewing = false;
		this.tui.setFocus(this.editor ?? null);
		this.tui.requestRender();
	}

	private stateFor(runId: string): DetailState {
		let state = this.detailStates.get(runId);
		if (!state) {
			const input = new Input();
			input.onSubmit = this.messageInput.onSubmit;
			state = { input, draft: "", revision: 0, viewport: new TranscriptViewport(), sending: false };
			this.detailStates.set(runId, state);
		}
		return state;
	}

	private openDetail(): void {
		const record = this.selectedRecord();
		if (!record) return;
		this.detail = true;
		this.messageInput.focused = false;
		const state = this.stateFor(record.runId);
		this.messageInput = state.input;
		this.messageInput.setValue(state.draft);
		if (this.detailRunId !== record.runId) {
			this.transcriptFile = undefined;
		}
		this.detailRunId = record.runId;

		// A focused overlay is important here: Pi's fullscreen TUI otherwise
		// consumes page keys and mouse-wheel events for the main conversation
		// before they reach this widget.
		const showOverlay = (this.tui as TUI & { showOverlay?: TUI["showOverlay"] }).showOverlay;
		if (typeof showOverlay === "function") {
			const overlay = new SubagentDetailOverlay(this);
			this.detailOverlay = overlay;
			this.overlayHandle = showOverlay.call(this.tui, overlay, {
				width: "100%",
				maxHeight: "100%",
				anchor: "center",
				margin: OVERLAY_MARGIN,
			});
		} else {
			// Keeps lightweight callers/tests that provide only the old TUI subset
			// usable; real Pi always has showOverlay().
			this.messageInput.focused = true;
		}
		this.tui.requestRender();
	}

	private clearCopyFeedback(state: DetailState): void {
		if (state.copyFeedbackTimer) clearTimeout(state.copyFeedbackTimer);
		state.copyFeedbackTimer = undefined;
		state.copyStatus = undefined;
		state.copyError = false;
	}

	private copyPath(record: AgentRecord, value: string): void {
		const state = this.stateFor(record.runId);
		if (state.copying || !this.options.onCopyPath) return;
		this.clearCopyFeedback(state);
		state.copying = true;
		state.copyError = false;
		state.copyStatus = "Copying path…";
		this.tui.requestRender();
		void Promise.resolve().then(() => this.options.onCopyPath!(value)).then(
			() => {
				if (this.disposed || state.copyStatus !== "Copying path…") return;
				state.copyStatus = "Copied path";
				state.copyFeedbackTimer = setTimeout(() => {
					this.clearCopyFeedback(state);
					if (!this.disposed && this.detail && this.detailRunId === record.runId) this.tui.requestRender();
				}, COPY_FEEDBACK_MS);
				state.copyFeedbackTimer.unref?.();
			},
			(error) => {
				if (this.disposed || state.copyStatus !== "Copying path…") return;
				state.copyError = true;
				state.copyStatus = `Copy failed: ${error instanceof Error ? error.message : String(error)}`;
			},
		).finally(() => {
			state.copying = false;
			if (!this.disposed) this.tui.requestRender();
		});
	}

	private closeDetail(): void {
		if (this.detailRunId) {
			const state = this.stateFor(this.detailRunId);
			state.draft = this.messageInput.getValue();
			this.clearCopyFeedback(state);
		}
		this.detail = false;
		this.draggingScrollbar = false;
		this.pressedDetailButton = undefined;
		this.pressedPath = undefined;
		this.detailGeometry = undefined;
		this.messageInput.focused = false;
		const handle = this.overlayHandle;
		this.overlayHandle = undefined;
		this.detailOverlay = undefined;
		if (handle) {
			handle.hide();
		} else {
			this.tui.setFocus(this);
		}
		this.tui.requestRender();
	}

	/** Called by the overlay wrapper so the embedded editor keeps IME focus. */
	setDetailInputFocused(value: boolean): void {
		this.messageInput.focused = value && this.detail;
	}

	private detailMaxHeight(): number {
		const rows = this.tui.terminal?.rows;
		return typeof rows === "number" && Number.isFinite(rows)
			? Math.max(1, rows - OVERLAY_MARGIN * 2)
			: MAX_TRANSCRIPT_LINES + 8;
	}

	renderDetailForOverlay(width: number): string[] {
		return this.renderDetail(width, this.detailMaxHeight());
	}

	private watchRegistry(): void {
		if (this.watcher || this.disposed) return;
		try {
			const watcher = watch(registryDir(this.agentDir), () => this.scheduleRefresh());
			this.watcher = watcher;
			watcher.unref();
			watcher.on("error", () => {
				watcher.close();
				if (this.watcher === watcher) this.watcher = undefined;
			});
		} catch {
			// The registry may not exist yet. The fallback poll retries the watch.
		}
	}

	private scheduleRefresh(): void {
		if (this.disposed || this.refreshTimer) return;
		this.refreshTimer = setTimeout(() => {
			this.refreshTimer = undefined;
			void this.refreshAsync();
		}, REGISTRY_DEBOUNCE_MS);
		this.refreshTimer.unref?.();
	}

	private async refreshAsync(): Promise<void> {
		if (this.disposed) return;
		if (this.refreshing) {
			this.refreshQueued = true;
			return;
		}
		this.refreshing = true;
		const version = this.refreshVersion;
		try {
			const records = await readRecordsAsync(this.agentDir);
			if (this.disposed) return;
			// An explicit open/dismiss may have read a newer snapshot while I/O was pending.
			if (version !== this.refreshVersion) {
				this.refreshQueued = true;
				return;
			}
			const before = JSON.stringify(this.records);
			this.applyRecords(records);
			if (before !== JSON.stringify(this.records)) this.tui.requestRender();
		} catch {
			// Keep the last good snapshot on transient storage errors; retry on the next wake.
		} finally {
			this.refreshing = false;
			if (this.refreshQueued) {
				this.refreshQueued = false;
				this.scheduleRefresh();
			}
		}
	}

	private refresh(): void {
		this.refreshVersion++;
		this.applyRecords(readRecords(this.agentDir));
	}

	private applyRecords(records: AgentRecord[]): void {
		const selectedId = this.rows()[this.selected]?.runId;
		this.records = descendantsOf(records, this.currentRunId);
		this.visible = this.records.filter((record) => !record.footerDismissed);
		const rows = this.rows();
		const restored = selectedId ? rows.findIndex((record) => record.runId === selectedId) : -1;
		this.selected = restored >= 0 ? restored : Math.min(this.selected, Math.max(0, rows.length - 1));
		if (this.detail && (rows.length === 0 || (selectedId && restored < 0))) this.closeDetail();
		if (this.focused && rows.length === 0) this.close();
	}

	private scrollByWheel(delta: number): boolean {
		if (!Number.isFinite(delta) || delta === 0) return false;
		const record = this.selectedRecord();
		return record ? this.stateFor(record.runId).viewport.scrollBy(Math.sign(delta) * SCROLL_STEP) : false;
	}

	private handleWheel(data: string): boolean {
		const match = /^\x1b\[<(\d+);(\d+);(\d+)[Mm]$/.exec(data);
		if (!match) return false;
		const button = Number(match[1]);
		if (!Number.isFinite(button) || (button & 64) === 0) return false;
		const direction = button & 3;
		if (direction === 0) this.scrollByWheel(-1);
		else if (direction === 1) this.scrollByWheel(1);
		else return false;
		this.tui.requestRender();
		return true;
	}

	handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
		if (!this.detail) return undefined;
		if (event.type === "wheel" && event.wheelDelta) return { handled: true, render: this.scrollByWheel(event.wheelDelta) };
		const geometry = this.detailGeometry;
		const record = this.selectedRecord();
		if (!geometry || !record) return undefined;
		const viewport = this.stateFor(record.runId).viewport;
		const onBar = event.x === geometry.width - 1 && event.y >= geometry.bodyTop && event.y < geometry.bodyTop + geometry.bodyHeight;
		if (this.draggingScrollbar || (onBar && event.button === "left" && event.type === "press")) {
			if (event.type === "release") this.draggingScrollbar = false;
			else if (event.type !== "click") this.draggingScrollbar = true;
			viewport.scrollToFraction((event.y - geometry.bodyTop) / Math.max(1, geometry.bodyHeight - 1));
			this.tui.requestRender();
			return { handled: true, capture: event.type === "press" };
		}
		if (event.button !== "left") return undefined;
		const pressed = this.pressedDetailButton;
		const pressedPath = this.pressedPath;
		if (event.type === "release") {
			this.pressedDetailButton = undefined;
			this.pressedPath = undefined;
		}
		if (event.y === geometry.pathY && event.x >= geometry.pathStart && event.x < geometry.pathEnd && this.options.onCopyPath) {
			if (event.type === "press") {
				this.pressedPath = { runId: record.runId, path: geometry.cwd };
				return { handled: true, capture: true };
			}
			if (event.type === "release" && pressedPath?.runId === record.runId) this.copyPath(record, pressedPath.path);
			return { handled: true };
		}
		if (event.y === geometry.controlsY) {
			const button = geometry.buttons.find(b => event.x >= b.start && event.x < b.end);
			if (!button) return undefined;
			if (event.type === "press") {
				this.pressedDetailButton = button.action;
				return { handled: true, capture: true };
			}
			if (event.type !== "release" || pressed !== button.action) return { handled: true };
			if (button.action === "back") this.closeDetail();
			else {
				if (button.action === "start") viewport.scrollToStart(); else viewport.scrollToEnd();
				this.tui.requestRender();
			}
			return { handled: true };
		}
		if (event.y >= geometry.bodyTop && event.y < geometry.bodyTop + geometry.bodyHeight) {
			const local = viewport.contentMouse({ ...event, y: event.y - geometry.bodyTop });
			const result = local ? this.stateFor(record.runId).transcript?.view.handleMouse(local) : undefined;
			if (result) this.tui.requestRender();
			return result;
		}
		if (event.y === geometry.inputY) {
			const result = this.messageInput.handleMouse({ ...event, y: 0 });
			if (result) this.tui.requestRender();
			return result;
		}
		return undefined;
	}

	handleInput(data: string): void {
		// Left arrow (Esc as an alias) always goes back one level:
		// detail -> list -> editor.
		if (
			matchesKey(data, Key.escape) ||
			matchesKey(data, Key.ctrl("c")) ||
			(matchesKey(data, Key.left) && (!this.detail || this.messageInput.getValue().length === 0))
		) {
			if (this.detail) this.closeDetail();
			else this.close();
			return;
		}
		if (this.detail) {
			if (this.handleWheel(data)) return;
			const record = this.selectedRecord();
			if (!record) return;
			const state = this.stateFor(record.runId);
			const page = Math.max(1, (this.detailGeometry?.bodyHeight ?? SCROLL_PAGE) - 1);
			const bindings = getKeybindings();
			const matchesAppKey = (action: "app.tools.expand" | "app.thinking.toggle", fallback: "o" | "t") => bindings.getDefinition(action)
				? bindings.matches(data, action) : matchesKey(data, Key.ctrl(fallback));
			if (matchesAppKey("app.tools.expand", "o")) this.transcriptView(record)?.toggleTools();
			else if (matchesAppKey("app.thinking.toggle", "t")) this.transcriptView(record)?.toggleThinking();
			else if (matchesKey(data, Key.ctrl("home"))) state.viewport.scrollToStart();
			else if (matchesKey(data, Key.ctrl("end"))) state.viewport.scrollToEnd();
			else if (matchesKey(data, Key.up)) state.viewport.scrollBy(-SCROLL_STEP);
			else if (matchesKey(data, Key.down)) state.viewport.scrollBy(SCROLL_STEP);
			else if (matchesKey(data, Key.pageUp)) state.viewport.scrollBy(-page);
			else if (matchesKey(data, Key.pageDown)) state.viewport.scrollBy(page);
			else {
				this.messageInput.handleInput(data);
				const value = this.messageInput.getValue();
				if (state.draft !== value) { state.draft = value; state.revision++; }
			}
			this.tui.requestRender();
			return;
		}
		// Enter or Right arrow opens the selected subagent.
		if (matchesKey(data, Key.enter) || matchesKey(data, Key.right)) {
			this.openDetail();
			return;
		}
		if (matchesKey(data, Key.up)) {
			if (this.selected === 0) this.close();
			else this.selected--;
			this.tui.requestRender();
			return;
		}
		if (matchesKey(data, Key.down)) {
			this.selected = Math.min(this.rows().length - 1, this.selected + 1);
			this.tui.requestRender();
			return;
		}
		if (data === "x") {
			const record = this.rows()[this.selected];
			if (record && !isTerminal(record)) {
				try {
					this.options.onCancel?.(record);
				} catch {
					// stdin delivers this key. The callback's failure must not
					// become the uncaughtException that exits Pi.
				}
			}
			this.tui.requestRender();
		}
	}

	render(width: number): string[] {
		if (this.focused && this.detail && !this.overlayHandle) return this.renderDetail(width);
		return this.renderTree(width);
	}

	private mainLine(): string {
		const main = this.theme.fg("accent", this.theme.bold("main"));
		return this.mainModel ? `${main} ${this.theme.fg("dim", `· ${this.mainModel}`)}` : main;
	}

	private rowBody(record: AgentRecord): string {
		const icon = this.theme.fg(statusColor(record), statusIcon(record));
		const activity = record.currentTool || record.activity || record.status;
		const sep = this.theme.fg("dim", " · ");
		const segments = [
			record.model ? this.theme.fg("dim", record.model) : undefined,
			this.theme.fg("dim", activity),
			...(isTerminal(record) ? [this.theme.fg("dim", elapsed(record))] : []),
		].filter((segment): segment is string => Boolean(segment));
		return `${icon} ${record.name}  ${segments.join(sep)}`;
	}

	private renderTree(width: number): string[] {
		// One tree for every state: the footer while typing, the focused list
		// after Down, and /subagents history. Only selection and hints differ.
		const rows = this.rows();
		if (rows.length === 0) return [];
		const byId = new Map(rows.map((r) => [r.runId, r]));
		const isLast = (record: AgentRecord): boolean => {
			const siblings = rows.filter((r) => r.parentRunId === record.parentRunId);
			return siblings[siblings.length - 1]?.runId === record.runId;
		};
		const ancestorChain = (record: AgentRecord): AgentRecord[] => {
			const chain: AgentRecord[] = [];
			let current = record;
			while (current.parentRunId !== this.currentRunId && byId.has(current.parentRunId)) {
				current = byId.get(current.parentRunId)!;
				chain.unshift(current);
			}
			return chain;
		};
		const selectedRunId = this.focused ? rows[this.selected]?.runId : undefined;
		const start = this.focused
			? Math.max(0, Math.min(rows.length - MAX_FOOTER_ROWS, this.selected - Math.floor(MAX_FOOTER_ROWS / 2)))
			: 0;
		const window = rows.slice(start, start + MAX_FOOTER_ROWS);
		const lines = [this.mainLine() + (this.reviewing ? this.theme.fg("dim", "  · history") : "")];
		if (start > 0) lines.push(this.theme.fg("dim", "  …"));
		for (const record of window) {
			const prefix =
				ancestorChain(record).map((a) => (isLast(a) ? "   " : "│  ")).join("") +
				(isLast(record) ? "└─ " : "├─ ");
			const line = truncateToWidth(prefix + this.rowBody(record), width, "…");
			if (this.focused && record.runId === selectedRunId) {
				lines.push(this.theme.bg("selectedBg", line + " ".repeat(Math.max(0, width - visibleWidth(line)))));
			} else {
				lines.push(line);
			}
		}
		if (start + window.length < rows.length) {
			lines.push(this.theme.fg("dim", `… +${rows.length - start - window.length} more`));
		}
		lines.push(this.theme.fg("dim", this.focused ? "↑/↓ select   Enter/→ open   x stop   ← back" : "↓ inspect"));
		return lines.map((line) => truncateToWidth(line, width, ""));
	}

	private transcriptView(record: AgentRecord): TranscriptView | null {
		const file = record.sessionFile ?? this.transcriptFile;
		if (!file) {
			const now = Date.now();
			if (now - this.lastDiscover > 2000) {
				this.lastDiscover = now;
				void discoverSessionFile(record.cwd, record.sessionId).then((found) => {
					if (found && this.selectedRecord()?.runId === record.runId) {
						this.transcriptFile = found;
						this.tui.requestRender();
					}
				});
			}
			return null;
		}
		if (record.sessionFile) this.transcriptFile = record.sessionFile;
		let key: string;
		try {
			const stat = statSync(file);
			key = `${file}:${stat.mtimeMs}:${stat.size}`;
		} catch {
			return null;
		}
		const state = this.stateFor(record.runId);
		if (!state.transcript || state.transcript.key !== key) {
			const view = state.transcript?.view ?? new TranscriptView(this.tui, record.cwd);
			if (!view.update(file)) {
				if (!state.transcript) view.dispose();
				return null;
			}
			state.transcript = { key, view };
		}
		return state.transcript?.view ?? null;
	}

	private legacyDetail(record: AgentRecord, width: number): string[] {
		const lines = [
			this.theme.fg("muted", "Task"),
			...wrapTextWithAnsi(record.task, Math.max(1, width)).slice(0, 3),
			"",
			this.theme.fg("muted", "Current activity"),
			truncateToWidth(record.currentTool || record.activity || record.status, width, "…"),
		];
		if (record.latestText) {
			lines.push("", this.theme.fg("muted", "Latest output"), ...wrapTextWithAnsi(record.latestText, Math.max(1, width)).slice(-4));
		}
		if (record.error) lines.push("", this.theme.fg("error", truncateToWidth(record.error, width, "…")));
		return lines;
	}

	private renderDetail(width: number, maxHeight = MAX_TRANSCRIPT_LINES + 8): string[] {
		const record = this.rows()[this.selected];
		if (!record) return [];
		const height = Math.max(1, maxHeight);
		const state = this.stateFor(record.runId);
		const oneLine = (text: string) => text.replace(/[\r\n]/g, " ");
		const icon = this.theme.fg(statusColor(record), statusIcon(record));
		const title = `Subagent: ${icon} ${this.theme.bold(oneLine(record.name))} · ${record.status} · ${elapsed(record)}`;
		const divider = this.theme.fg("dim", "─".repeat(Math.max(0, width)));
		const segments = [{ text: title, path: false }];
		if (height >= 5) segments.push({ text: this.theme.fg("dim", oneLine(`${record.model}${record.thinking !== "off" ? `:${record.thinking}` : ""}${width >= 80 ? ` · #${record.runId.slice(0, 8)}` : ""}`)), path: false });
		if (height >= 7) segments.push({ text: this.theme.fg("muted", `Path: ${oneLine(shortPath(record.cwd))}`), path: true });
		const header: string[] = [];
		let pathY: number | undefined;
		let pathStart = 0;
		let pathEnd = 0;
		for (const segment of segments) {
			const previous = header.at(-1);
			const prefix = previous === undefined ? "" : previous + this.theme.fg("dim", " · ");
			const fits = previous !== undefined && visibleWidth(prefix + segment.text) <= width;
			if (fits) header[header.length - 1] = prefix + segment.text;
			else header.push(segment.text);
			if (segment.path) {
				pathY = header.length - 1;
				pathStart = fits ? visibleWidth(prefix) : 0;
				pathEnd = Math.min(width, pathStart + visibleWidth(segment.text));
			}
		}
		if (height >= 9) header.push(divider);
		const status = state.copyStatus ?? state.status;
		const error = state.copyStatus ? state.copyError : state.error;
		const footer = [
			...(height >= 9 ? [divider] : []),
			...(height >= 6 ? [this.theme.fg(error ? "error" : "muted", `${status ? `${oneLine(status)} · ` : ""}Message this subagent · Enter send`)] : []),
			...this.messageInput.render(width).slice(0, 1),
		];
		const textWidth = Math.max(1, width - 2);
		const transcript = this.transcriptView(record);
		const rendered = transcript?.render(textWidth);
		const body = rendered?.length ? rendered.map(clean) : this.legacyDetail(record, textWidth);
		if (rendered?.length && record.activity === "responding" && record.latestText) {
			body.push("", this.theme.fg("dim", "live"), ...wrapTextWithAnsi(record.latestText, textWidth));
		}
		const view = state.viewport.render(body, width, Math.max(0, height - header.length - footer.length - 1), text => this.theme.fg("dim", text));
		const labels = width >= 50 ? ["[Esc back]", "[↑ Start]", "[↓ Latest]"] : width >= 28 ? ["[Esc back]", "[Start]", "[Latest]"] : ["[Esc]", "[↑]", "[↓]"];
		let column = 0;
		const buttons = labels.map((label, index) => {
			const start = column;
			column += visibleWidth(label) + 1;
			return { start, end: column - 1, action: (["back", "start", "latest"] as const)[index] };
		});
		const help = this.theme.fg("dim", `${labels.join(" ")}${width >= 40 ? " · PgUp/PgDn" : ""}`);
		this.detailGeometry = { width, bodyTop: header.length, bodyHeight: view.lines.length, inputY: height - 2, controlsY: height - 1, buttons, pathY, pathStart, pathEnd, cwd: record.cwd };
		const lines = height < 4 ? [title, ...footer].slice(0, height - 1).concat(help) : [...header, ...view.lines, ...footer, help];
		// Fill every cell and row: overlay transparency must never expose the parent.
		return Array.from({ length: height }, (_, row) => {
			const line = truncateToWidth(lines[row] ?? "", Math.max(0, width), "");
			return line + " ".repeat(Math.max(0, width - visibleWidth(line)));
		});
	}

	invalidate(): void {
		this.messageInput.invalidate();
		for (const state of this.detailStates.values()) state.transcript?.view.invalidate();
	}

	dispose(): void {
		this.disposed = true;
		for (const state of this.detailStates.values()) {
			this.clearCopyFeedback(state);
			state.transcript?.view.dispose();
		}
		this.watcher?.close();
		this.watcher = undefined;
		if (this.refreshTimer) clearTimeout(this.refreshTimer);
		this.refreshTimer = undefined;
		this.detail = false;
		this.messageInput.focused = false;
		this.overlayHandle?.hide();
		this.overlayHandle = undefined;
		this.detailOverlay = undefined;
		clearInterval(this.timer);
	}
}

/**
 * Focus target used by the transcript overlay. The persistent panel remains a
 * below-editor widget; this wrapper lets Pi's viewport defer page/mouse scroll
 * events while the transcript is open.
 */
class SubagentDetailOverlay implements Component, Focusable {
	private _focused = false;

	get focused(): boolean {
		return this._focused;
	}

	set focused(value: boolean) {
		this._focused = value;
		this.panel.setDetailInputFocused(value);
	}

	constructor(private readonly panel: SubagentPanel) {}

	handleInput(data: string): void {
		this.panel.handleInput(data);
	}

	handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
		return this.panel.handleMouse(event);
	}

	render(width: number): string[] {
		return this.panel.renderDetailForOverlay(width);
	}

	invalidate(): void {
		this.panel.invalidate();
	}
}
