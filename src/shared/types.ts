import type { CursorTelemetryPoint } from "../vendor/recordly/types";

/** Recordly's cursor-type keys (CursorTelemetryPoint.cursorType). */
export type PointerCursor = NonNullable<CursorTelemetryPoint["cursorType"]>;

/**
 * One pointer sample logged by the content script. The recorder logs wall-clock ms (Date.now());
 * bundles handed to the editor are rebased so `t` is ms since MediaRecorder started.
 */
export interface PointerEvt {
	t: number;
	/**
	 * "down"/"up" are the primary (left) button; "rightclick"/"middleclick" are presses of
	 * buttons 2/1. Double-clicks are not a separate kind: like Recordly's recordCursorMouseDown,
	 * toTelemetry() marks a left press as a double-click from its timing and distance.
	 */
	kind: "move" | "down" | "up" | "rightclick" | "middleclick";
	/** Normalised to the page viewport (tab capture). */
	tab: [number, number];
	/** Normalised to the outer browser window (window capture). */
	win: [number, number];
	/** Normalised to the monitor the window is on (screen capture). */
	mon: [number, number];
	/** Cursor shape under the pointer, as a Recordly cursor-type key. */
	cursor: PointerCursor;
}

export type Surface = "browser" | "window" | "monitor";

export interface RecordingMeta {
	id: string;
	createdAt: number;
	/** Date.now() when MediaRecorder started; pointer times are relative to this. */
	startedAt: number;
	durationMs: number;
	surface: Surface;
	width: number;
	height: number;
	hasCamera: boolean;
	hasMic: boolean;
}

export interface RecordingBundle {
	meta: RecordingMeta;
	screen: Blob;
	camera: Blob | null;
	events: PointerEvt[];
}

export interface RecordOptions {
	mic: boolean;
	camera: boolean;
	surface: Surface;
}
