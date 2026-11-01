// Glide pointer log -> Recordly cursor telemetry.
//
// Recordly records the cursor in its Electron main process (electron/ipc/cursor/*.ts) and the
// editor consumes CursorTelemetryPoint[]. Glide's content script logs PointerEvt instead, so this
// module is the browser-side equivalent of Recordly's capture step:
// - pick the coordinates normalised to the captured surface (Recordly: getNormalizedCursorPoint,
//   which clamps to the selected window/display);
// - map presses like recordCursorMouseDown / recordCursorMouseUp
//   (electron/ipc/cursor/interaction.ts), including its double-click rule;
// - then run the editor's normalizeCursorTelemetry() (timeline/zoomSuggestionUtils.ts).
import type { PointerEvt, Surface } from "../shared/types";
import type { CursorTelemetryPoint } from "../vendor/recordly/types";
import { normalizeCursorTelemetry } from "../vendor/recordly/zoomSuggestionUtils";

/** recordCursorMouseDown: a left press within 350 ms and 0.04 of the previous left press is a double-click. */
export const DOUBLE_CLICK_THRESHOLD_MS = 350;
export const DOUBLE_CLICK_MAX_DISTANCE = 0.04;

const SURFACE_KEY = { browser: "tab", window: "win", monitor: "mon" } as const satisfies Record<Surface, keyof PointerEvt>;

/**
 * Convert the content script's events into Recordly telemetry on the video timeline,
 * normalised by Recordly's own normalizeCursorTelemetry (sort, clamp to [0,1] and [0,totalMs],
 * infer text / closed-hand cursor types around selections and drags).
 *
 * Event `t` is ms since MediaRecorder.onstart; the webm's pts 0 is the capture track's first
 * frame, stamped earlier (see RecordingMeta.videoOriginAt). `offsetMs` = startedAt - videoOriginAt
 * moves each event onto the pts axis, or the drawn cursor leads the baked one by that gap.
 */
export function toTelemetry(events: PointerEvt[], surface: Surface, totalMs: number, offsetMs = 0): CursorTelemetryPoint[] {
	const key = SURFACE_KEY[surface] ?? "tab";
	const sorted = [...events].sort((a, b) => a.t - b.t);
	const points: CursorTelemetryPoint[] = [];
	let lastLeftClick: { timeMs: number; cx: number; cy: number } | null = null;

	for (const e of sorted) {
		const p = e[key];
		if (!p) continue;
		const [cx, cy] = p;
		const timeMs = Math.max(0, e.t + offsetMs);
		let interactionType: NonNullable<CursorTelemetryPoint["interactionType"]>;
		switch (e.kind) {
			case "down": {
				interactionType = "click";
				const distance = lastLeftClick
					? Math.hypot(cx - lastLeftClick.cx, cy - lastLeftClick.cy)
					: Number.POSITIVE_INFINITY;
				if (
					lastLeftClick &&
					timeMs - lastLeftClick.timeMs <= DOUBLE_CLICK_THRESHOLD_MS &&
					distance <= DOUBLE_CLICK_MAX_DISTANCE
				) {
					interactionType = "double-click";
				}
				lastLeftClick = { timeMs, cx, cy };
				break;
			}
			case "rightclick":
				interactionType = "right-click";
				break;
			case "middleclick":
				interactionType = "middle-click";
				break;
			case "up":
				interactionType = "mouseup";
				break;
			default:
				interactionType = "move";
		}
		points.push({ timeMs, cx, cy, interactionType, cursorType: e.cursor ?? "arrow" });
	}

	return normalizeCursorTelemetry(points, totalMs);
}
