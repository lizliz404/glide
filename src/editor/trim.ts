// Cursorful's observed non-destructive range workflow, adapted to Glide's source-time timeline.
// The source media, zooms and cursor data stay untouched; only playback/export bounds change.
export interface TrimRange { startMs: number; endMs: number }
export const MIN_TRIM_MS = 100;

export function fullTrim(durationMs: number): TrimRange {
	return { startMs: 0, endMs: durationMs };
}

export function validTrim(value: unknown, durationMs: number): value is TrimRange {
	if (!value || typeof value !== "object") return false;
	const r = value as TrimRange;
	return Number.isFinite(r.startMs) && Number.isFinite(r.endMs)
		&& r.startMs >= 0 && r.endMs <= durationMs
		&& r.endMs - r.startMs >= Math.min(MIN_TRIM_MS, durationMs) && r.endMs > r.startMs;
}

export function setTrimEdge(range: TrimRange, edge: "start" | "end", atMs: number, durationMs: number): TrimRange {
	const min = Math.min(MIN_TRIM_MS, durationMs);
	if (edge === "start") return { startMs: Math.max(0, Math.min(atMs, range.endMs - min)), endMs: range.endMs };
	return { startMs: range.startMs, endMs: Math.min(durationMs, Math.max(atMs, range.startMs + min)) };
}
