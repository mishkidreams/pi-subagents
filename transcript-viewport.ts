import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

/** View-only position. Keeping an absolute top preserves reading during append;
 * following the end is an explicit, independent state. No session data is edited.
 */
export class TranscriptViewport {
	private top = 0;
	private total = 0;
	private height = 0;
	private following = true;

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

	render(body: string[], width: number, height: number, style: (text: string) => string): { lines: string[]; position: string; mode: "FOLLOW" | "HISTORY" } {
		this.total = body.length;
		this.height = Math.max(0, height);
		const maxTop = Math.max(0, this.total - this.height);
		this.top = this.following ? maxTop : Math.min(this.top, maxTop);
		const thumb = Math.min(this.height, Math.max(1, Math.round(this.height * this.height / Math.max(1, this.total))));
		const thumbTop = maxTop === 0 ? 0 : Math.round((this.height - thumb) * this.top / maxTop);
		const textWidth = Math.max(0, width - 2);
		const lines = Array.from({ length: this.height }, (_, row) => {
			const text = truncateToWidth(body[this.top + row] ?? "", textWidth, "");
			const bar = style(row >= thumbTop && row < thumbTop + thumb ? "█" : "░");
			return width < 2 ? truncateToWidth(bar, width, "") : text + " ".repeat(Math.max(0, width - 1 - visibleWidth(text))) + bar;
		});
		const end = Math.min(this.total, this.top + this.height);
		const start = end ? this.top + 1 : 0;
		const mode = this.following ? "FOLLOW" : "HISTORY";
		return { lines, position: `${start}–${end}/${this.total} · ${mode}`, mode };
	}
}
