import { truncateToWidth, visibleWidth, type TuiMouseEvent } from "@earendil-works/pi-tui";

/** View-only position. Keeping an absolute top preserves reading during append;
 * following the end is an explicit, independent state. No session data is edited.
 */
export class TranscriptViewport {
	private top = 0;
	private total = 0;
	private height = 0;
	private following = true;
	private width = 0;

	scrollBy(lines: number): boolean {
		const before = this.top;
		this.top = Math.max(0, Math.min(Math.max(0, this.total - this.height), this.top + lines));
		this.following = this.top === Math.max(0, this.total - this.height);
		return this.top !== before;
	}

	scrollToStart(): void {
		this.top = 0;
		this.following = false;
	}

	scrollToEnd(): void {
		this.following = true;
	}

	scrollToFraction(fraction: number): void {
		const bounded = Math.max(0, Math.min(1, fraction));
		this.top = Math.round(Math.max(0, this.total - this.height) * bounded);
		this.following = bounded === 1;
	}

	render(body: string[], width: number, height: number, style: (text: string) => string, tail: string[] = []): { lines: string[] } {
		this.width = width;
		this.total = body.length + tail.length;
		this.height = Math.max(0, height);
		const maxTop = Math.max(0, this.total - this.height);
		this.top = this.following ? maxTop : Math.min(this.top, maxTop);
		const thumb = Math.min(this.height, Math.max(1, Math.round(this.height * this.height / Math.max(1, this.total))));
		const thumbTop = maxTop === 0 ? 0 : Math.round((this.height - thumb) * this.top / maxTop);
		const textWidth = Math.max(0, width - 2);
		const lines = Array.from({ length: this.height }, (_, row) => {
			const index = this.top + row;
			const text = truncateToWidth((index < body.length ? body[index] : tail[index - body.length]) ?? "", textWidth, "");
			const bar = style(row >= thumbTop && row < thumbTop + thumb ? "█" : "░");
			return width < 2 ? truncateToWidth(bar, width, "") : text + " ".repeat(Math.max(0, width - 1 - visibleWidth(text))) + bar;
		});
		return { lines };
	}

	/** Translate the last painted viewport, never its scrollbar or padding column. */
	contentMouse(event: TuiMouseEvent): TuiMouseEvent | undefined {
		const textWidth = Math.max(0, this.width - 2);
		if (event.x < 0 || event.x >= textWidth || event.y < 0 || event.y >= this.height || event.y + this.top >= this.total) return undefined;
		return { ...event, y: event.y + this.top, width: textWidth, height: this.total };
	}
}
