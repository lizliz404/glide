// Virtual camera: when to zoom, where to look, and how the camera moves. A port of Recordly
// (AGPL-3.0, webadderallorg/Recordly @ e4a9d04), with no policy of our own:
// - suggestZoomRegions(): timeline/zoomSuggestionUtils.buildInteractionZoomSuggestions turned
//   into ZoomRegion[] exactly like hooks/useZoomRegionCommands.handleZoomSuggested, gated like
//   hooks/useFreshRecordingAutoZoom (source aspect >= 1.2) and handleSuggestZooms (>= 2 samples).
// - SceneCamera.step(): src/lib/exporter/frameRenderer.ts updateAnimationState (L1596-1677):
//   resolveSceneZoomTarget -> computeZoomTransform -> per-axis stepSpringValue with
//   getZoomSpringConfig, advanced by content-time dt. snap mirrors VideoPlayback.tsx's "snap"
//   motion mode (seek): exact target, springs reset, follow camera restarted afterwards.
// - ZOOM_DEFAULTS: cursorMotionPresets "focused" (DEFAULT_MOTION_PRESET) + projectPersistence
//   normalizeProjectEditor defaults.
import { CURSOR_MOTION_PRESETS } from "../vendor/recordly/cursorMotionPresets";
import {
	type CursorFollowCameraState,
	createCursorFollowCameraState,
} from "../vendor/recordly/cursorFollowCamera";
import {
	createSpringState,
	getZoomSpringConfig,
	resetSpringState,
	type SpringState,
	stepSpringValue,
} from "../vendor/recordly/motionSmoothing";
import { resolveSceneZoomTarget } from "../vendor/recordly/sceneMotion";
import {
	clampFocusToDepth,
	type CursorTelemetryPoint,
	DEFAULT_AUTO_ZOOM_DEPTH,
	DEFAULT_ZOOM_SMOOTHNESS,
	type ZoomDepth,
	type ZoomRegion,
} from "../vendor/recordly/types";
import {
	buildInteractionZoomSuggestions,
	shouldAutoApplyFreshRecordingZoomsForSource,
} from "../vendor/recordly/zoomSuggestionUtils";
import { computeZoomTransform } from "../vendor/recordly/zoomTransformMath";

interface Rect {
	x: number;
	y: number;
	width: number;
	height: number;
}

export interface ZoomConfig {
	connectZooms: boolean;
	zoomInDurationMs: number;
	zoomOutDurationMs: number;
	zoomSmoothness: number;
	cameraSpring: { stiffnessMultiplier: number; dampingMultiplier: number; massMultiplier: number };
	classicMode: boolean;
	autoZoomDepth: ZoomDepth;
}

const FOCUSED = CURSOR_MOTION_PRESETS.focused;

/** Recordly's out-of-the-box zoom behaviour (Focused preset). */
export const ZOOM_DEFAULTS: ZoomConfig = {
	// projectPersistence: connectZooms defaults to true
	connectZooms: true,
	// cursorMotionPresets.focused: 200 / 200 ms
	zoomInDurationMs: FOCUSED.zoomInDurationMs,
	zoomOutDurationMs: FOCUSED.zoomOutDurationMs,
	// projectPersistence: zoomSmoothness = DEFAULT_ZOOM_SMOOTHNESS (0.5)
	zoomSmoothness: DEFAULT_ZOOM_SMOOTHNESS,
	// projectPersistence: camera spring multipliers 1 / 1.13 / 1.12
	cameraSpring: { stiffnessMultiplier: 1, dampingMultiplier: 1.13, massMultiplier: 1.12 },
	// projectPersistence: zoomClassicMode defaults to false
	classicMode: false,
	// useZoomRegionCommands.handleZoomSuggested: DEFAULT_AUTO_ZOOM_DEPTH (3 -> 1.8x)
	autoZoomDepth: DEFAULT_AUTO_ZOOM_DEPTH,
};

/** Default region length used by the timeline (useTimelineZoomActions: min(1000, totalMs)). */
const DEFAULT_REGION_DURATION_MS = 1000;

/**
 * Click-driven auto zoom regions, as Recordly applies them to a fresh recording.
 * Returns [] for portrait / near-square sources (aspect < 1.2), with fewer than two telemetry
 * samples, or when there are no explicit clicks.
 */
export function suggestZoomRegions(
	t: CursorTelemetryPoint[],
	totalMs: number,
	sourceAspect: number,
	cfg: ZoomConfig = ZOOM_DEFAULTS,
): ZoomRegion[] {
	if (!shouldAutoApplyFreshRecordingZoomsForSource(sourceAspect, 1)) return [];
	if (totalMs <= 0 || t.length < 2) return [];
	const defaultDurationMs = Math.min(DEFAULT_REGION_DURATION_MS, totalMs);
	if (defaultDurationMs <= 0) return [];

	const result = buildInteractionZoomSuggestions({
		cursorTelemetry: t,
		totalMs,
		defaultDurationMs,
		reservedSpans: [],
	});
	if (result.status !== "ok") return [];

	const depth = cfg.autoZoomDepth;
	return result.suggestions.map((s, i) => ({
		id: `auto-${i + 1}`,
		startMs: Math.round(s.start),
		endMs: Math.round(s.end),
		depth,
		focus: clampFocusToDepth(s.focus, depth),
		mode: "auto",
	}));
}

/**
 * Camera for one frame, in output pixels. Apply as translate(x, y) then scale(scale) to the
 * video layer (frame + video + cursor); the background stays put. Same semantics as
 * computeZoomTransform / frameRenderer's AnimationState.
 */
export interface CameraTransform {
	/** Applied (sprung) layer scale. */
	scale: number;
	/** Applied (sprung) layer translation, px. */
	x: number;
	y: number;
	/** Zoom strength of the dominant region, 0..1 (target, not sprung). */
	progress: number;
	/** Scale to feed reactive overlays (webcam bubble): frameRenderer passes appliedScale || 1. */
	zoomScale: number;
}

export class SceneCamera {
	private cfg: ZoomConfig;
	private springScale: SpringState = createSpringState(1);
	private springX: SpringState = createSpringState(0);
	private springY: SpringState = createSpringState(0);
	private follow: CursorFollowCameraState = createCursorFollowCameraState();
	private followNeedsReset = false;
	private lastContentTimeMs: number | null = null;
	private last: CameraTransform = { scale: 1, x: 0, y: 0, progress: 0, zoomScale: 1 };

	constructor(cfg: ZoomConfig) {
		this.cfg = cfg;
	}

	setConfig(cfg: ZoomConfig): void {
		this.cfg = cfg;
	}

	/** Back to frameRenderer's initial state (call on seek / before export). */
	reset(): void {
		resetSpringState(this.springScale, 1);
		resetSpringState(this.springX, 0);
		resetSpringState(this.springY, 0);
		this.follow = createCursorFollowCameraState();
		this.followNeedsReset = false;
		this.lastContentTimeMs = null;
		this.last = { scale: 1, x: 0, y: 0, progress: 0, zoomScale: 1 };
	}

	/**
	 * Advance to content time `timeMs`. Springs use the dt between successive calls (content time,
	 * not wall clock), like export. `snap` jumps straight to the target, like the preview after a
	 * seek. A repeated or earlier time without snap keeps the last frame (preview "preserve").
	 */
	step(
		timeMs: number,
		stage: { width: number; height: number },
		mask: Rect,
		telemetry: CursorTelemetryPoint[],
		regions: ZoomRegion[],
		snap = false,
	): CameraTransform {
		const cfg = this.cfg;
		const deltaMs = this.lastContentTimeMs !== null ? timeMs - this.lastContentTimeMs : 1000 / 60;
		if (!snap && this.lastContentTimeMs !== null && deltaMs <= 0) {
			return this.last;
		}
		this.lastContentTimeMs = timeMs;

		if (snap) {
			// VideoPlayback: frozen frames sample with an independent follow camera, and the
			// persistent one restarts when springing resumes.
			this.followNeedsReset = true;
		} else if (this.followNeedsReset) {
			this.follow = createCursorFollowCameraState();
			this.followNeedsReset = false;
		}

		const target = resolveSceneZoomTarget({
			zoomRegions: regions,
			timeMs,
			cursorTimeMs: timeMs,
			connectZooms: cfg.connectZooms,
			zoomInDurationMs: cfg.zoomInDurationMs,
			zoomOutDurationMs: cfg.zoomOutDurationMs,
			zoomClassicMode: cfg.classicMode,
			cursorTelemetry: telemetry,
			cursorFollowCamera: snap ? createCursorFollowCameraState() : this.follow,
		});

		const projected = computeZoomTransform({
			stageSize: stage,
			baseMask: mask,
			zoomScale: target.scale,
			zoomProgress: target.progress,
			focusX: target.focus.cx,
			focusY: target.focus.cy,
		});

		let scale: number;
		let x: number;
		let y: number;
		if (snap || cfg.classicMode) {
			scale = projected.scale;
			x = projected.x;
			y = projected.y;
			resetSpringState(this.springScale, scale);
			resetSpringState(this.springX, x);
			resetSpringState(this.springY, y);
		} else {
			const springConfig = getZoomSpringConfig(cfg.zoomSmoothness, cfg.cameraSpring);
			scale = stepSpringValue(this.springScale, projected.scale, deltaMs, springConfig);
			x = stepSpringValue(this.springX, projected.x, deltaMs, springConfig);
			y = stepSpringValue(this.springY, projected.y, deltaMs, springConfig);
		}

		this.last = { scale, x, y, progress: target.progress, zoomScale: scale || 1 };
		return this.last;
	}
}

// ---------------------------------------------------------------------------------------------
// Legacy shim: the pre-port API that main.ts, export.ts and render.ts still import. P1 may not
// edit those files; P5 switches them to toTelemetry/suggestZoomRegions/SceneCamera and deletes
// everything below together with src/vendor/openscreen. Only change: a press of any button
// counts as a click (PointerEvt gained "rightclick"/"middleclick").
// ---------------------------------------------------------------------------------------------
import { AUTO_FOLLOW_PARAMS } from "../vendor/openscreen/constants";
import { advanceFollowFocus, interpolateCursorAt } from "../vendor/openscreen/cursorFollowUtils";
import type { CursorTelemetryPoint as LegacyTelemetryPoint, ZoomFocus } from "../vendor/openscreen/types";
import { createZoomSpringState, resetZoomSpring, stepZoomSpring, type ZoomSpringState, type ZoomTransform } from "../vendor/openscreen/zoomSpring";
import {
	createSpringState as createLegacySpringState,
	getCursorSpringConfig,
	stepSpringValue as stepLegacySpringValue,
	type SpringState as LegacySpringState,
} from "../vendor/openscreen/motionSmoothing";
import type { PointerEvt, Surface } from "../shared/types";
import type { Settings } from "./settings";

/** @deprecated legacy (pre-port) API, removed by P5. */
export interface ZoomSegment {
	start: number;
	end: number;
	clicks: number[];
}

export interface Track {
	telemetry: LegacyTelemetryPoint[];
	clicks: { t: number; x: number; y: number }[];
	cursorStyle: { t: number; c: PointerEvt["cursor"] }[];
}

export function buildTrack(events: PointerEvt[], surface: Surface): Track {
	const key = surface === "browser" ? "tab" : surface === "window" ? "win" : "mon";
	const sorted = [...events].sort((a, b) => a.t - b.t);
	const inside = (p: [number, number]) => p[0] >= -0.02 && p[0] <= 1.02 && p[1] >= -0.02 && p[1] <= 1.02;
	const telemetry: LegacyTelemetryPoint[] = [];
	const clicks: Track["clicks"] = [];
	const cursorStyle: Track["cursorStyle"] = [];
	for (const e of sorted) {
		const p = e[key];
		if (!p || !inside(p)) continue;
		telemetry.push({ timeMs: e.t, cx: p[0], cy: p[1], interactionType: e.kind === "up" ? "mouseup" : e.kind === "move" ? "move" : "click" });
		if (e.kind !== "move" && e.kind !== "up") clicks.push({ t: e.t, x: p[0], y: p[1] });
		cursorStyle.push({ t: e.t, c: e.cursor });
	}
	return { telemetry, clicks, cursorStyle };
}

/** Group clicks into zoom windows: clicks closer than gapMs share one zoom. */
export function buildSegments(track: Track, z: Settings["zoom"], durationMs: number): ZoomSegment[] {
	const groups: number[][] = [];
	for (const c of track.clicks) {
		const g = groups[groups.length - 1];
		if (g && c.t - g[g.length - 1] <= z.gapMs) g.push(c.t);
		else groups.push([c.t]);
	}
	const segs: ZoomSegment[] = [];
	for (const g of groups) {
		if (g.length < z.minClicks) continue;
		const seg = { start: Math.max(0, g[0] - z.leadMs), end: Math.min(durationMs, g[g.length - 1] + z.holdMs), clicks: g };
		const prev = segs[segs.length - 1];
		if (prev && seg.start - prev.end < 800) {
			prev.end = seg.end;
			prev.clicks.push(...seg.clicks);
		} else segs.push(seg);
	}
	return segs;
}

export interface CameraFrame {
	/** Visible window of the source, normalised (x,y = top-left). */
	view: { x: number; y: number; w: number; h: number };
	scale: number;
	cursor: (ZoomFocus & { style: PointerEvt["cursor"]; pressed: boolean }) | null;
}

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

/** @deprecated legacy (pre-port) camera, removed by P5 once main.ts/export.ts use SceneCamera. */
export class Camera {
	private zoom: ZoomSpringState = createZoomSpringState();
	private focus: ZoomFocus = { cx: 0.5, cy: 0.5 };
	private cursorX: LegacySpringState = createLegacySpringState(0.5);
	private cursorY: LegacySpringState = createLegacySpringState(0.5);
	private lastSeg: ZoomSegment | null = null;
	private lastT = -1;

	constructor(
		private track: Track,
		private segments: ZoomSegment[],
		private settings: Settings,
	) {}

	update(track: Track, segments: ZoomSegment[], settings: Settings) {
		this.track = track;
		this.segments = segments;
		this.settings = settings;
	}

	private segmentAt(t: number) {
		return this.settings.zoom.enabled ? (this.segments.find((s) => t >= s.start && t <= s.end) ?? null) : null;
	}

	private target(t: number, dtMs: number, snap: boolean): ZoomTransform {
		const seg = this.segmentAt(t);
		const raw = interpolateCursorAt(this.track.telemetry, t);
		if (!seg) {
			this.lastSeg = null;
			this.focus = { cx: 0.5, cy: 0.5 };
			return { scale: 1, x: 0.5, y: 0.5 };
		}
		const scale = this.settings.zoom.scale;
		if (seg !== this.lastSeg || snap) {
			// Entering a zoom: aim at the first click of the group (or cursor if following).
			const first = this.track.clicks.find((c) => c.t >= seg.start) ?? null;
			this.focus = first ? { cx: first.x, cy: first.y } : (raw ?? { cx: 0.5, cy: 0.5 });
			this.lastSeg = seg;
		} else if (this.settings.zoom.follow && raw) {
			this.focus = advanceFollowFocus(this.focus, raw, dtMs, AUTO_FOLLOW_PARAMS);
		} else if (!this.settings.zoom.follow) {
			const last = [...this.track.clicks].reverse().find((c) => c.t <= t && c.t >= seg.start);
			if (last) this.focus = { cx: last.x, cy: last.y };
		}
		const half = 0.5 / scale;
		return { scale, x: clamp(this.focus.cx, half, 1 - half), y: clamp(this.focus.cy, half, 1 - half) };
	}

	/** Advance to time t (ms). Large jumps (seek) snap instead of animating. */
	frame(t: number, dtMs: number): CameraFrame {
		const snap = this.lastT < 0 || t < this.lastT || t - this.lastT > 300;
		this.lastT = t;
		const target = this.target(t, dtMs, snap);
		let z: ZoomTransform;
		if (snap) {
			resetZoomSpring(this.zoom, target);
			z = target;
		} else z = stepZoomSpring(this.zoom, target, dtMs);

		const scale = Math.max(1, z.scale);
		const w = 1 / scale;
		const view = { x: clamp(z.x - w / 2, 0, 1 - w), y: clamp(z.y - w / 2, 0, 1 - w), w, h: w };

		let cursor: CameraFrame["cursor"] = null;
		const raw = interpolateCursorAt(this.track.telemetry, t);
		if (raw && this.track.telemetry.length && t >= this.track.telemetry[0].timeMs) {
			const cfg = getCursorSpringConfig(this.settings.cursor.smoothing);
			if (snap) {
				this.cursorX = createLegacySpringState(raw.cx);
				this.cursorY = createLegacySpringState(raw.cy);
			}
			const cx = stepLegacySpringValue(this.cursorX, raw.cx, dtMs, cfg);
			const cy = stepLegacySpringValue(this.cursorY, raw.cy, dtMs, cfg);
			const st = lastBefore(this.track.cursorStyle, t)?.c ?? "arrow";
			const pressed = this.track.telemetry.some((p) => p.interactionType === "click" && t - p.timeMs >= 0 && t - p.timeMs < 140);
			cursor = { cx, cy, style: st, pressed };
		}
		return { view, scale, cursor };
	}
}

function lastBefore<T extends { t: number }>(arr: T[], t: number): T | undefined {
	let lo = 0;
	let hi = arr.length - 1;
	let best: T | undefined;
	while (lo <= hi) {
		const mid = (lo + hi) >> 1;
		if (arr[mid].t <= t) {
			best = arr[mid];
			lo = mid + 1;
		} else hi = mid - 1;
	}
	return best;
}
