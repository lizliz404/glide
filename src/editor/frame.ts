// Background + frame (padding, squircle radius, shadow) settings, ported from Recordly.
// Defaults: src/components/video-editor/projectPersistence.ts (normalizeProjectEditor) and types.ts.
// Wallpapers: the five Recordly built-ins Liz picked, labels/ids from src/lib/wallpapers.ts.
import { computePaddedLayout, scalePreviewBorderRadius } from "../vendor/recordly/layoutMath";
import { DEFAULT_CROP_REGION, type CropRegion } from "../vendor/recordly/types";

export type Rect = { x: number; y: number; width: number; height: number };

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

/** Recordly src/lib/wallpapers.ts: createWallpaperEntry(fileName, label) -> { id, label, relativePath }. */
export const WALLPAPERS: { id: string; label: string; url: string }[] = [
	{ id: "tahoe-light", label: "Tahoe Light", url: "wallpapers/tahoe-light.jpg" },
	{ id: "tahoe-dark", label: "Tahoe Dark", url: "wallpapers/tahoe-dark.jpg" },
	{ id: "sequoia-blue-orange", label: "Sequoia Blue Orange", url: "wallpapers/sequoia-blue-orange.jpg" },
	{ id: "ventura", label: "Ventura", url: "wallpapers/ventura.jpg" },
	{ id: "glassmorphism-4", label: "Glassmorphism 4", url: "wallpapers/glassmorphism-4.jpg" },
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
