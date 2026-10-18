// Non-destructive browser-chrome crop. Persisted pointer and zoom coordinates stay in the original
// source frame; preview/export project them into the visible crop once, locally.
import type { CropRegion, CursorTelemetryPoint, ZoomFocus, ZoomRegion } from "../vendor/recordly/types";
import { DEFAULT_CROP_REGION } from "../vendor/recordly/types";
import { projectCursorPositionToViewport } from "../vendor/recordly/cursorViewport";

export interface BrowserView {
	hideTop: boolean;
	topPx: number;
}

export const BROWSER_VIEW_DEFAULTS: BrowserView = { hideTop: false, topPx: 100 };

const MAX_TOP_PX = 100_000;

function finite(value: unknown, fallback: number): number {
	const n = typeof value === "number" ? value : Number(value);
	return Number.isFinite(n) ? n : fallback;
}

/** Bounded numeric view. Missing or invalid values use the defaults; no auto detection. */
export function normalizeBrowserView(value: unknown): BrowserView {
	const raw = value && typeof value === "object" ? (value as Partial<BrowserView>) : {};
	const topPx = finite(raw.topPx, BROWSER_VIEW_DEFAULTS.topPx);
	return {
		hideTop: raw.hideTop === true,
		topPx: Math.min(MAX_TOP_PX, Math.max(0, topPx)),
	};
}

/**
 * Top strip of the source frame, as a Recordly CropRegion. A crop that would leave no picture
 * (topPx >= videoHeight) stays the full frame.
 */
export function browserCrop(view: BrowserView, videoHeight: number): CropRegion {
	const height = finite(videoHeight, 0);
	if (!view.hideTop || !(view.topPx > 0) || !(height > view.topPx)) return { ...DEFAULT_CROP_REGION };
	const y = view.topPx / height;
	return { x: 0, y, width: 1, height: 1 - y };
}

function clamp01(value: number): number {
	return Math.min(1, Math.max(0, value));
}

function projectFocus(focus: ZoomFocus, crop: CropRegion): ZoomFocus {
	const projected = projectCursorPositionToViewport(focus, crop);
	return { cx: clamp01(projected.cx), cy: clamp01(projected.cy) };
}

export interface ProjectedScene {
	telemetry: CursorTelemetryPoint[];
	regions: ZoomRegion[];
}

/**
 * Map original source-normalized telemetry and region focus into the visible crop.
 * Points outside the crop are dropped, not clamped to the edge. Returned arrays and region
 * objects are new; the inputs are not mutated.
 */
export function projectSceneForCrop(
	telemetry: readonly CursorTelemetryPoint[],
	regions: readonly ZoomRegion[],
	crop: CropRegion,
): ProjectedScene {
	const full = crop.x === 0 && crop.y === 0 && crop.width === 1 && crop.height === 1;
	if (full) return { telemetry: telemetry.slice(), regions: regions.slice() };
	return {
		telemetry: telemetry.flatMap((point) => {
			const p = projectCursorPositionToViewport(point, crop);
			return p.visible ? [{ ...point, cx: p.cx, cy: p.cy }] : [];
		}),
		regions: regions.map((region) => ({ ...region, focus: projectFocus(region.focus, crop) })),
	};
}
