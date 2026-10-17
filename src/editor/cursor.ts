// Glide cursor layer: Recordly's cursor (Golden Gate / "tahoe" pack, spring smoothing, click bounce,
// sway, click effects) drawn with Canvas 2D. P2's renderFrame calls draw() through its drawCursor hook
// INSIDE the camera transform, with the video mask rect as the viewport, exactly where frameRenderer
// parents its cursor overlay (cameraContainer -> cursorContainer) and passes layoutCache.maskRect.
import {
	CanvasCursorOverlay,
	DEFAULT_CURSOR_CONFIG,
	isCursorAssetsLoaded,
	preloadCursorAssets as preloadRecordlyCursorAssets,
	type CursorRenderConfig,
} from "../vendor/recordly/cursorCanvas";
import { CURSOR_MOTION_PRESETS } from "../vendor/recordly/cursorMotionPresets";
import type { CursorSpringTuning } from "../vendor/recordly/motionSmoothing";
import {
	type CursorClickEffectStyle,
	type CursorStyle,
	type CursorTelemetryPoint,
	DEFAULT_CURSOR_CLICK_EFFECT,
	DEFAULT_CURSOR_CLICK_EFFECT_COLOR,
	DEFAULT_CURSOR_STYLE,
	DEFAULT_CURSOR_SWAY,
} from "../vendor/recordly/types";

export type Ctx2D = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;
export type Rect = { x: number; y: number; width: number; height: number };

export interface CursorConfig {
	show: boolean;
	style: CursorStyle;
	size: number;
	smoothing: number;
	spring: CursorSpringTuning;
	clickEffect: CursorClickEffectStyle;
	clickEffectColor: string;
	clickBounce: number;
	clickBounceDuration: number;
	sway: number;
}

const FOCUSED = CURSOR_MOTION_PRESETS.focused;

/** Recordly defaults: the "focused" motion preset (DEFAULT_MOTION_PRESET) on top of E/types.ts. */
export const CURSOR_DEFAULTS: CursorConfig = {
	show: true,
	style: DEFAULT_CURSOR_STYLE, // "tahoe" = Golden Gate in Recordly's UI
	size: FOCUSED.cursorSize, // 2.5 (raw DEFAULT_CURSOR_SIZE 3.0 is overridden by the preset)
	smoothing: FOCUSED.cursorSmoothing, // 0.67
	spring: {
		stiffnessMultiplier: FOCUSED.cursorSpringStiffnessMultiplier, // 1.35
		dampingMultiplier: FOCUSED.cursorSpringDampingMultiplier, // 0.79
		massMultiplier: FOCUSED.cursorSpringMassMultiplier, // 1.29
	},
	clickEffect: DEFAULT_CURSOR_CLICK_EFFECT, // "none"
	clickEffectColor: DEFAULT_CURSOR_CLICK_EFFECT_COLOR, // "#2563EB"
	clickBounce: FOCUSED.cursorClickBounce, // 2
	clickBounceDuration: FOCUSED.cursorClickBounceDuration, // 350
	sway: DEFAULT_CURSOR_SWAY, // 0.4
};

/** Loads and rasterizes every cursor set once. Await before export; preview draws once ready. */
export function preloadCursorAssets(): Promise<void> {
	return preloadRecordlyCursorAssets();
}

/** Mirrors frameRenderer ≈L399–426 (new PixiCursorOverlay({...})) for the fields glide exposes. */
export function toRenderConfig(cfg: CursorConfig): Partial<CursorRenderConfig> {
	return {
		dotRadius: DEFAULT_CURSOR_CONFIG.dotRadius * cfg.size,
		style: cfg.style,
		smoothingFactor: cfg.smoothing,
		springTuning: { ...cfg.spring },
		motionBlur: 0, // Pixi-only in Recordly; not ported
		clickEffect: cfg.clickEffect,
		clickEffectColor: cfg.clickEffectColor,
		clickEffectScale: DEFAULT_CURSOR_CONFIG.clickEffectScale,
		clickEffectOpacity: DEFAULT_CURSOR_CONFIG.clickEffectOpacity,
		clickEffectDurationMs: DEFAULT_CURSOR_CONFIG.clickEffectDurationMs,
		clickBounce: cfg.clickBounce,
		clickBounceDuration: cfg.clickBounceDuration,
		sway: cfg.sway,
	};
}

export class CursorLayer {
	private cfg: CursorConfig;
	private overlay: CanvasCursorOverlay;
	private preloadStarted = false;

	constructor(cfg: CursorConfig) {
		this.cfg = cfg;
		this.overlay = new CanvasCursorOverlay(toRenderConfig(cfg));
	}

	/** Applies a new config without losing the smoothed position (like the Pixi overlay setters). */
	setConfig(cfg: CursorConfig): void {
		this.cfg = cfg;
		const o = this.overlay;
		o.setDotRadius(DEFAULT_CURSOR_CONFIG.dotRadius * cfg.size);
		o.setStyle(cfg.style);
		o.setSmoothingFactor(cfg.smoothing);
		o.setSpringTuning(cfg.spring);
		o.setClickEffect(cfg.clickEffect);
		o.setClickEffectColor(cfg.clickEffectColor);
		o.setClickBounce(cfg.clickBounce);
		o.setClickBounceDuration(cfg.clickBounceDuration);
		o.setSway(cfg.sway);
	}

	/** Call on seek / before export frame 0. */
	reset(): void {
		this.overlay.reset();
	}

	/** Draws the cursor for `timeMs` into `viewport` (the video mask, already camera-transformed). */
	draw(ctx: Ctx2D, telemetry: CursorTelemetryPoint[], timeMs: number, viewport: Rect): void {
		if (!isCursorAssetsLoaded()) {
			if (!this.preloadStarted) {
				this.preloadStarted = true;
				preloadCursorAssets().catch((error) =>
					console.warn("[glide] cursor assets failed to load; cursor hidden", error),
				);
			}
			return;
		}
		this.overlay.update(ctx, telemetry, timeMs, viewport, this.cfg.show, false);
	}

	/** Test/debug hook: current smoothed position (0–1 in the viewport) and sway (radians). */
	snapshot() {
		return { cursor: this.overlay.getSmoothedCursorSnapshot(), sway: this.overlay.getSwayRotation() };
	}
}
