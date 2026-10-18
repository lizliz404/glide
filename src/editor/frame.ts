// Background + frame (padding, squircle radius, shadow) settings, ported from Recordly.
// Defaults: src/components/video-editor/projectPersistence.ts (normalizeProjectEditor) and types.ts.
// Wallpapers: every image Recordly ships, ids/labels from src/lib/wallpapers.ts (see WALLPAPERS below).
import { computePaddedLayout, scalePreviewBorderRadius } from "../vendor/recordly/layoutMath";
import { DEFAULT_CROP_REGION, type CropRegion } from "../vendor/recordly/types";

export type Rect = { x: number; y: number; width: number; height: number };

// `color` and `gradient` are no longer offered in the picker (Liz, 2026-10-18: Recordly's wallpapers
// only). They stay in the type because projects saved before that decision still load them.
export type Background = { kind: "image"; url: string } | { kind: "color"; color: string } | { kind: "gradient"; css: string };

export interface FrameStyle {
	background: Background;
	/** 0–100, Recordly's linked padding percent (× PADDING_SCALE_FACTOR 0.2 of W/H per side). */
	padding: number;
	/** 0–50, percent of the video rect's shorter side. */
	borderRadius: number;
	/** 0–1, scales Recordly's three stacked drop-shadows. */
	shadowIntensity: number;
	/** 0–8, scaled by width / 640 like Recordly's sceneEffects. */
	backgroundBlur: number;
}

/**
 * Recordly src/lib/wallpapers.ts: createWallpaperEntry(fileName, label) -> { id, label, relativePath }.
 *
 * 19 of the 38 image wallpapers from Recordly's `public/wallpapers/` @ e4a9d04, copied byte-exact into
 * `static/wallpapers/` (Liz, 2026-10-18: ship every Recordly wallpaper, add none of our own).
 * Order: Recordly's own picker order (`BUILT_IN_WALLPAPERS`) first, then the images that sit in that
 * folder without a picker entry, alphabetically; the labels for those follow Recordly's
 * `toWallpaperLabel` naming ("wallpaper1.jpg" -> "Wallpaper 1").
 * `wispysky.mp4` is the one file not listed: the renderer has no video-background path
 * (src/vendor/recordly/wallpaperFill.ts handles images, colours and gradients), so it would paint
 * black. Follow-up, not a regression.
 */
export const WALLPAPERS: { id: string; label: string; url: string }[] = [
	{ id: "tahoe-light", label: "Tahoe Light", url: "wallpapers/tahoe-light.jpg" },
	{ id: "midnight-8", label: "Midnight 8", url: "wallpapers/midnight-8.jpg" },
	{ id: "sequoia-blue", label: "Sequoia Blue", url: "wallpapers/sequoia-blue.jpg" },
	{ id: "sequoia-blue-orange", label: "Sequoia Blue Orange", url: "wallpapers/sequoia-blue-orange.jpg" },
	{ id: "ventura", label: "Ventura", url: "wallpapers/ventura.jpg" },
	{ id: "glassmorphism-3", label: "Glassmorphism 3", url: "wallpapers/glassmorphism-3.jpg" },
	{ id: "wallpaper3", label: "Wallpaper 3", url: "wallpapers/wallpaper3.jpg" },
	{ id: "wallpaper4", label: "Wallpaper 4", url: "wallpapers/wallpaper4.jpg" },
	{ id: "cityscape", label: "Cityscape", url: "wallpapers/cityscape.jpg" },
	{ id: "wallpaper10", label: "Wallpaper 10", url: "wallpapers/wallpaper10.jpg" },
	{ id: "iridescent-9", label: "Iridescent 9", url: "wallpapers/iridescent-9.jpg" },
	{ id: "wallpaper1", label: "Wallpaper 1", url: "wallpapers/wallpaper1.jpg" },
	{ id: "wallpaper2", label: "Wallpaper 2", url: "wallpapers/wallpaper2.jpg" },
	{ id: "wallpaper7", label: "Wallpaper 7", url: "wallpapers/wallpaper7.jpg" },
	{ id: "wallpaper9", label: "Wallpaper 9", url: "wallpapers/wallpaper9.jpg" },
	{ id: "wallpaper11", label: "Wallpaper 11", url: "wallpapers/wallpaper11.jpg" },
	{ id: "wallpaper12", label: "Wallpaper 12", url: "wallpapers/wallpaper12.jpg" },
	{ id: "wallpaper13", label: "Wallpaper 13", url: "wallpapers/wallpaper13.jpg" },
	{ id: "wallpaper15", label: "Wallpaper 15", url: "wallpapers/wallpaper15.jpg" },
];

/** Recordly DEFAULT_WALLPAPER_RELATIVE_PATH. */
export const DEFAULT_WALLPAPER_URL = "wallpapers/tahoe-light.jpg";

export const FRAME_DEFAULTS: FrameStyle = {
	background: { kind: "image", url: DEFAULT_WALLPAPER_URL },
	// projectPersistence: DEFAULT_PADDING = 20 (linked).
	padding: 20,
	// projectPersistence: MACOS_DEFAULT_BORDER_RADIUS_PERCENT = 8 on macOS, 0 elsewhere. Glide uses the
	// macOS value on every OS so Liz gets the rounded look (deliberate deviation).
	borderRadius: 8,
	// projectPersistence: shadowIntensity 0.67.
	shadowIntensity: 0.67,
	// projectPersistence: backgroundBlur 0.
	backgroundBlur: 0,
};

export interface FrameLayout {
	mask: Rect;
	radiusPx: number;
	/** Where the full (uncropped) source is drawn so the crop lands in `mask` (Recordly spriteX/Y × scale). */
	sprite: Rect;
}

/** Recordly layoutVideoContent() minus Pixi: computePaddedLayout + squircle radius, full crop by default. */
export function computeFrameLayout(
	W: number,
	H: number,
	videoW: number,
	videoH: number,
	s: FrameStyle,
	cropRegion: CropRegion = DEFAULT_CROP_REGION,
): FrameLayout {
	const layout = computePaddedLayout({
		width: W,
		height: H,
		padding: s.padding,
		cropRegion,
		videoWidth: videoW,
		videoHeight: videoH,
	});
	const mask = {
		x: layout.centerOffsetX,
		y: layout.centerOffsetY,
		width: layout.croppedDisplayWidth,
		height: layout.croppedDisplayHeight,
	};
	return {
		mask,
		radiusPx: scalePreviewBorderRadius(mask.width, mask.height, s.borderRadius),
		sprite: { x: layout.spriteX, y: layout.spriteY, width: layout.fullVideoDisplayWidth, height: layout.fullVideoDisplayHeight },
	};
}

/** Background -> Recordly's wallpaper string (image path, "#hex"/colour, or CSS gradient). */
export function backgroundToWallpaper(bg: Background): string {
	return bg.kind === "image" ? bg.url : bg.kind === "color" ? bg.color : bg.css;
}
