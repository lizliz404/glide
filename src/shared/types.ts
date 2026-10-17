/** One pointer sample logged by the content script. Times are wall-clock ms (Date.now()). */
export interface PointerEvt {
	t: number;
	kind: "move" | "down" | "up";
	/** Normalised to the page viewport (tab capture). */
	tab: [number, number];
	/** Normalised to the outer browser window (window capture). */
	win: [number, number];
	/** Normalised to the monitor the window is on (screen capture). */
	mon: [number, number];
	/** Coarse cursor style under the pointer, used to pick the drawn cursor. */
	cursor: "arrow" | "pointer" | "text";
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
