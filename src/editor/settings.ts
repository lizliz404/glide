// Every default here is Recordly's (webadderallorg/Recordly @ e4a9d04): the P1–P4 modules own their
// sections and this file only composes them, plus motion presets (cursorMotionPresets.ts) applied the
// way projectPersistence.normalizeProjectEditor / SettingsPanel.applyCursorMotionPreset do.
import { CURSOR_MOTION_PRESETS, type CursorMotionPresetId } from "../vendor/recordly/cursorMotionPresets";
import { ZOOM_DEFAULTS, type ZoomConfig } from "./camera";
import { CURSOR_DEFAULTS, type CursorConfig } from "./cursor";
import { FRAME_DEFAULTS, type FrameStyle } from "./frame";
import { WEBCAM_DEFAULTS, type WebcamStyle } from "./webcam";

export type Aspect = "16:9" | "9:16" | "4:3" | "3:4" | "1:1";

export interface GlideSettings {
	/** projectPersistence: aspectRatio "16:9". */
	aspect: Aspect;
	/** projectPersistence: DEFAULT_MOTION_PRESET "focused". */
	motionPreset: CursorMotionPresetId;
	/** editorPreferences: autoApplyFreshRecordingAutoZooms (true). */
	autoApplyZooms: boolean;
	zoom: ZoomConfig;
	frame: FrameStyle;
	webcam: WebcamStyle;
	cursor: CursorConfig;
}

const clone = <T>(v: T): T => structuredClone(v);

export function defaultSettings(): GlideSettings {
	return {
		aspect: "16:9",
		motionPreset: "focused",
		autoApplyZooms: true,
		zoom: clone(ZOOM_DEFAULTS),
		frame: clone(FRAME_DEFAULTS),
		webcam: clone(WEBCAM_DEFAULTS),
		cursor: clone(CURSOR_DEFAULTS),
	};
}

/** SettingsPanel.applyCursorMotionPreset: zoom durations + smoothness and the cursor motion block. */
export function applyMotionPreset(s: GlideSettings, id: CursorMotionPresetId): void {
	const p = CURSOR_MOTION_PRESETS[id];
	s.motionPreset = id;
	s.zoom.zoomSmoothness = p.zoomSmoothness;
	s.zoom.zoomInDurationMs = p.zoomInDurationMs;
	s.zoom.zoomOutDurationMs = p.zoomOutDurationMs;
	s.cursor.size = p.cursorSize;
	s.cursor.smoothing = p.cursorSmoothing;
	s.cursor.spring = {
		stiffnessMultiplier: p.cursorSpringStiffnessMultiplier,
		dampingMultiplier: p.cursorSpringDampingMultiplier,
		massMultiplier: p.cursorSpringMassMultiplier,
	};
	s.cursor.clickBounce = p.cursorClickBounce;
	s.cursor.clickBounceDuration = p.cursorClickBounceDuration;
}

const KEY = "glide.settings.v2";

/** Saved settings merged over the defaults; uploaded (blob:) backgrounds are never restored. */
export function loadSettings(storage: Pick<Storage, "getItem"> | null = globalThis.localStorage ?? null): GlideSettings {
	const d = defaultSettings();
	try {
		const raw = storage?.getItem(KEY);
		if (!raw) return d;
		const saved = JSON.parse(raw) as Partial<GlideSettings>;
		const s: GlideSettings = {
			...d,
			...saved,
			zoom: { ...d.zoom, ...saved.zoom, cameraSpring: { ...d.zoom.cameraSpring, ...saved.zoom?.cameraSpring } },
			frame: { ...d.frame, ...saved.frame },
			webcam: { ...d.webcam, ...saved.webcam },
			cursor: { ...d.cursor, ...saved.cursor, spring: { ...d.cursor.spring, ...saved.cursor?.spring } },
		};
		if (s.frame.background.kind === "image" && s.frame.background.url.startsWith("blob:")) s.frame.background = d.frame.background;
		return s;
	} catch {
		return d;
	}
}

export function saveSettings(s: GlideSettings, storage: Pick<Storage, "setItem"> | null = globalThis.localStorage ?? null): void {
	const copy = clone(s);
	if (copy.frame.background.kind === "image" && copy.frame.background.url.startsWith("blob:")) copy.frame.background = FRAME_DEFAULTS.background;
	storage?.setItem(KEY, JSON.stringify(copy));
}

export function outputSize(aspect: Aspect, base = 1080): { width: number; height: number } {
	const [w, h] = aspect.split(":").map(Number);
	// Short side = base; keep dimensions even for H.264.
	const even = (n: number) => Math.round(n / 2) * 2;
	return w >= h ? { width: even((base * w) / h), height: base } : { width: base, height: even((base * h) / w) };
}
