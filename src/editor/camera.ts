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
