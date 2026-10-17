// Copied from webadderallorg/Recordly (AGPL-3.0) @ e4a9d04860f4cbad3358bda3ac4a2307489f1d03
// Source: src/components/video-editor/videoPlayback/cursorRenderer.ts
// Changes:
//   - Removed Pixi (Assets, Texture, Sprite, Graphics, BlurFilter) and pixi-filters MotionBlurFilter.
//   - Asset loading (L214-473) rewritten without Pixi: fetch -> Blob -> decoded image (SVG via <img>
//     on an object URL, raster via createImageBitmap) -> rasterize/trim/invert on an OffscreenCanvas
//     (or <canvas>) -> ImageBitmap. Same raster height (512), trim, hotspot and inversion logic.
//     LoadedCursorAsset.texture/image(HTMLImageElement) -> image: ImageBitmap. Errors when no 2D
//     context instead of falling back to a Pixi texture.
//   - getRenderableAssetUrl (Electron asset protocol) dropped; the URL is fetched as-is.
//   - minimalCursorUrl Vite import -> runtime URL "cursors/custom/minimal-cursor.svg".
//   - Removed NativeCursorAtlas types, buildNativeCursorAtlas (Electron native overlay) and the atlas
//     constants.
//   - Removed drawClickEffectGraphics (Pixi Graphics twin of drawClickEffectOnCanvas).
//   - PixiCursorOverlay replaced by CanvasCursorOverlay: same update() state machine (smoothing,
//     discontinuity snap, bounce, sway, click effect) painting into a 2D context; motion blur and
//     setMotionBlur/setFilterResolution/destroy dropped. See the comment above the class.
//   - drawClickEffectOnCanvas / drawCursorOnCanvas take Ctx2D (HTML or Offscreen) instead of
//     CanvasRenderingContext2D; drawClickEffectOnCanvas and getCursorVisualState are exported.
//   - Added isCursorAssetsLoaded() (glide) so callers can skip drawing until preload finishes.
//   - Import paths: ../types -> ./types; ./zoomTransform -> ./directionalMotionBlur.

// Friendly reminder: Recordly is licensed under AGPL-3.0, author @webadderall, repo-> https://github.com/webadderall/Recordly
// Please use this code with the right attribution.

import {
	type CursorClickEffectStyle,
	type CursorStyle,
	type CursorTelemetryPoint,
	DEFAULT_CURSOR_CLICK_BOUNCE_DURATION,
	DEFAULT_CURSOR_CLICK_EFFECT,
	DEFAULT_CURSOR_CLICK_EFFECT_COLOR,
	DEFAULT_CURSOR_CLICK_EFFECT_DURATION_MS,
	DEFAULT_CURSOR_CLICK_EFFECT_OPACITY,
	DEFAULT_CURSOR_CLICK_EFFECT_SCALE,
	DEFAULT_CURSOR_STYLE,
	normalizeCursorClickEffectColor,
} from "./types";
import { getCursorViewportScale } from "./cursorScale";
import { computeCursorSwayRotation } from "./cursorSway";
import { type CursorViewportRect, projectCursorPositionToViewport } from "./cursorViewport";
import {
	type CursorSpringTuning,
	createSpringState,
	getCursorSpringConfig,
	resetSpringState,
	stepSpringValue,
} from "./motionSmoothing";
import { cursorSetAssets, getCursorStyleSizeMultiplier } from "./uploadedCursorAssets";
import { interpolateCursorPosition } from "./cursorPosition";
export { interpolateCursorPosition } from "./cursorPosition";

const minimalCursorUrl = "cursors/custom/minimal-cursor.svg";

type Ctx2D = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

type CursorAssetKey = NonNullable<CursorTelemetryPoint["cursorType"]>;
type StatefulCursorStyle = Extract<CursorStyle, "macos" | "tahoe" | "tahoe-inverted" | "windows11">;
type SingleCursorStyle = Extract<CursorStyle, "dot" | "figma">;
type CursorPackStyle = Exclude<CursorStyle, StatefulCursorStyle | SingleCursorStyle>;
type CursorPackVariant = "default" | "pointer";

type LoadedCursorAsset = {
	image: ImageBitmap;
	aspectRatio: number;
	anchorX: number;
	anchorY: number;
};

type LoadedCursorPackAssets = Record<CursorPackVariant, LoadedCursorAsset>;

type CursorPackSource = {
	defaultUrl: string;
	pointerUrl: string;
	defaultAnchor: { x: number; y: number };
	pointerAnchor: { x: number; y: number };
};

/**
 * Configuration for cursor rendering.
 */
export interface CursorRenderConfig {
	/** Base cursor height in pixels (at reference width of 1920px) */
	dotRadius: number;
	/** Minimum viewport scale applied to cursor sizing. */
	minViewportScale: number;
	/** Cursor fill color (hex number for PixiJS) */
	dotColor: number;
	/** Cursor opacity (0–1) */
	dotAlpha: number;
	/** Unused, kept for interface compatibility */
	trailLength: number;
	/** Smoothing factor for cursor interpolation (0–1, lower = smoother/slower) */
	smoothingFactor: number;
	/** Optional multipliers applied on top of the derived cursor spring config. */
	springTuning: CursorSpringTuning;
	/** Directional cursor motion blur amount. */
	motionBlur: number;
	/** Click bounce multiplier. */
	clickBounce: number;
	/** Click bounce duration in milliseconds. */
	clickBounceDuration: number;
	/** Click effect graphics rendered around the pointer. */
	clickEffect: CursorClickEffectStyle;
	/** Click effect base color. */
	clickEffectColor: string;
	/** Click effect size multiplier. */
	clickEffectScale: number;
	/** Click effect opacity multiplier. */
	clickEffectOpacity: number;
	/** Click effect duration in milliseconds. */
	clickEffectDurationMs: number;
	/** Cursor sway multiplier. */
	sway: number;
	/** Cursor visual style. */
	style: CursorStyle;
}

const MIN_CURSOR_VIEWPORT_SCALE = 0;
// Keep the cursor visually responsive while sharing the camera's frame-rate
// normalization, kernel, and directional offset formula.
const CURSOR_DIRECTIONAL_BLUR_STRENGTH = 2;
const CURSOR_TIME_DISCONTINUITY_MS = 100;
const CURSOR_SWAY_SMOOTHING_MULTIPLIER = 0.7;
const CURSOR_SWAY_SMOOTHING_OFFSET = 0.18;
const CURSOR_SVG_DROP_SHADOW_FILTER = "drop-shadow(0px 2px 3px rgba(0, 0, 0, 0.35))";
const CURSOR_SHADOW_COLOR = 0x000000;
const CURSOR_SHADOW_ALPHA = 0.35;
const CURSOR_SHADOW_OFFSET_X = 0;
const CURSOR_SHADOW_OFFSET_Y = 2;
const CURSOR_SHADOW_BLUR = 3;
const CURSOR_SHADOW_PADDING = 12;
const MIN_RASTERIZED_CURSOR_HEIGHT = 512;

export const DEFAULT_CURSOR_CONFIG: CursorRenderConfig = {
	dotRadius: 28,
	minViewportScale: MIN_CURSOR_VIEWPORT_SCALE,
	dotColor: 0xffffff,
	dotAlpha: 0.95,
	trailLength: 0,
	smoothingFactor: 0.18,
	springTuning: {
		stiffnessMultiplier: 1,
		dampingMultiplier: 1,
		massMultiplier: 1,
	},
	motionBlur: 0,
	clickBounce: 1,
	clickBounceDuration: DEFAULT_CURSOR_CLICK_BOUNCE_DURATION,
	clickEffect: DEFAULT_CURSOR_CLICK_EFFECT,
	clickEffectColor: DEFAULT_CURSOR_CLICK_EFFECT_COLOR,
	clickEffectScale: DEFAULT_CURSOR_CLICK_EFFECT_SCALE,
	clickEffectOpacity: DEFAULT_CURSOR_CLICK_EFFECT_OPACITY,
	clickEffectDurationMs: DEFAULT_CURSOR_CLICK_EFFECT_DURATION_MS,
	sway: 0,
	style: DEFAULT_CURSOR_STYLE,
};
let cursorAssetsPromise: Promise<void> | null = null;
let cursorPackAssetsPromise: Promise<void> | null = null;
let loadedCursorPackSourcesSignature = "";
let loadedCursorAssets: Partial<Record<CursorAssetKey, LoadedCursorAsset>> = {};
let loadedCursorSetAssets: Partial<
	Record<StatefulCursorStyle, Partial<Record<CursorAssetKey, LoadedCursorAsset>>>
> = {};
let loadedCursorStyleAssets: Partial<Record<SingleCursorStyle, LoadedCursorAsset>> = {};
let loadedCursorPackAssets: Partial<Record<string, LoadedCursorPackAssets>> = {};
const warnedMissingCursorPackStyles = new Set<string>();
const SUPPORTED_CURSOR_KEYS: CursorAssetKey[] = [
	"arrow",
	"text",
	"pointer",
	"crosshair",
	"open-hand",
	"closed-hand",
	"resize-ew",
	"resize-ns",
	"not-allowed",
];

const CURSOR_PACK_POINTER_TYPES = new Set<CursorAssetKey>(["pointer", "open-hand", "closed-hand"]);
const BUILTIN_CURSOR_PACK_SOURCES: Record<string, CursorPackSource> = {};

function getCursorPackSources(): Record<string, CursorPackSource> {
	return { ...BUILTIN_CURSOR_PACK_SOURCES };
}

function buildCursorPackSourcesSignature(sources: Record<string, CursorPackSource>): string {
	return Object.entries(sources)
		.sort(([left], [right]) => left.localeCompare(right))
		.map(
			([style, source]) =>
				`${style}:${source.defaultUrl}:${source.pointerUrl}:${source.defaultAnchor.x}:${source.defaultAnchor.y}:${source.pointerAnchor.x}:${source.pointerAnchor.y}`,
		)
		.join("|");
}

function isStatefulCursorStyle(style: CursorStyle): style is StatefulCursorStyle {
	return (
		style === "macos" ||
		style === "tahoe" ||
		style === "tahoe-inverted" ||
		style === "windows11"
	);
}

function isSingleCursorStyle(style: CursorStyle): style is SingleCursorStyle {
	return style === "dot" || style === "figma";
}

function resolveCursorPackVariant(cursorType: CursorAssetKey): CursorPackVariant {
	return CURSOR_PACK_POINTER_TYPES.has(cursorType) ? "pointer" : "default";
}

// ---- glide: Pixi-free asset loading (replaces Recordly L214-473) -----------------------------
// Same pipeline as Recordly (rasterize to >= MIN_RASTERIZED_CURSOR_HEIGHT, trim to alpha, move the
// hotspot with the crop, optional inversion), but every texture is an ImageBitmap built from a 2D
// canvas instead of a Pixi Texture/Assets.load, so the result draws on HTMLCanvasElement and
// OffscreenCanvas contexts alike (preview and export).

type RasterCanvas = HTMLCanvasElement | OffscreenCanvas;
type RasterContext = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

function createRasterCanvas(width: number, height: number): RasterCanvas {
	if (typeof OffscreenCanvas !== "undefined") {
		return new OffscreenCanvas(width, height);
	}
	const canvas = document.createElement("canvas");
	canvas.width = width;
	canvas.height = height;
	return canvas;
}

function get2d(canvas: RasterCanvas): RasterContext | null {
	return canvas.getContext("2d") as RasterContext | null;
}

/**
 * fetch -> Blob -> decoded image. Raster blobs go straight through createImageBitmap; SVG blobs
 * (which createImageBitmap cannot decode in Chromium) are decoded through an <img> on an object URL.
 */
async function loadImage(url: string): Promise<LoadedImage> {
	const response = await fetch(url);
	if (!response.ok) {
		throw new Error(`Failed to load cursor image: ${url.slice(0, 128)} (${response.status})`);
	}
	const blob = await response.blob();
	const isSvg = blob.type.includes("svg") || /\.svg($|\?)/i.test(url);
	if (!isSvg) {
		const bitmap = await createImageBitmap(blob);
		return { source: bitmap, width: bitmap.width, height: bitmap.height };
	}
	const objectUrl = URL.createObjectURL(blob);
	try {
		const image = await new Promise<HTMLImageElement>((resolve, reject) => {
			const img = new Image();
			img.onload = () => resolve(img);
			img.onerror = () =>
				reject(new Error(`Failed to load cursor image: ${url.slice(0, 128)}`));
			img.src = objectUrl;
		});
		return { source: image, width: image.naturalWidth, height: image.naturalHeight };
	} finally {
		URL.revokeObjectURL(objectUrl);
	}
}

type LoadedImage = { source: CanvasImageSource; width: number; height: number };

async function toBitmap(canvas: RasterCanvas): Promise<ImageBitmap> {
	return createImageBitmap(canvas);
}

async function createCursorStyleAsset(style: SingleCursorStyle): Promise<LoadedCursorAsset> {
	if (style === "figma") {
		const image = await loadImage(minimalCursorUrl);
		const sourceCanvas = createRasterCanvas(image.width, image.height);
		const sourceCtx = get2d(sourceCanvas)!;
		sourceCtx.drawImage(image.source, 0, 0);
		const trimmed = trimCanvasToAlpha(sourceCanvas, { x: 40, y: 22 });
		const trimmedImage = await toBitmap(trimmed.canvas);

		return {
			image: trimmedImage,
			aspectRatio: trimmed.height > 0 ? trimmed.width / trimmed.height : 1,
			anchorX: trimmed.hotspot && trimmed.width > 0 ? trimmed.hotspot.x / trimmed.width : 0,
			anchorY: trimmed.hotspot && trimmed.height > 0 ? trimmed.hotspot.y / trimmed.height : 0,
		};
	}

	const canvas = createRasterCanvas(112, 112);
	const ctx = get2d(canvas)!;
	const cx = canvas.width / 2;
	const cy = canvas.height / 2;
	const radius = 26;
	ctx.fillStyle = "#ffffff";
	ctx.strokeStyle = "rgba(15, 23, 42, 0.88)";
	ctx.lineWidth = 10;
	ctx.beginPath();
	ctx.arc(cx, cy, radius, 0, Math.PI * 2);
	ctx.fill();
	ctx.stroke();

	const image = await toBitmap(canvas);

	return {
		image,
		aspectRatio: canvas.height > 0 ? canvas.width / canvas.height : 1,
		anchorX: 0.5,
		anchorY: 0.5,
	};
}

async function createCursorPackAsset(
	url: string,
	anchor: { x: number; y: number },
): Promise<LoadedCursorAsset> {
	const image = await loadImage(url);
	const canvas = createRasterCanvas(Math.max(1, image.width), Math.max(1, image.height));
	get2d(canvas)?.drawImage(image.source, 0, 0);

	return {
		image: await toBitmap(canvas),
		aspectRatio: image.height > 0 ? image.width / image.height : 1,
		anchorX: clamp(anchor.x, 0, 1),
		anchorY: clamp(anchor.y, 0, 1),
	};
}

async function createRasterizedCursorAsset(
	url: string,
	anchor: { x: number; y: number },
	options: { preserveCanvas?: boolean } = {},
): Promise<LoadedCursorAsset> {
	const image = await loadImage(url);
	const rasterScale =
		image.height > 0 ? Math.max(1, MIN_RASTERIZED_CURSOR_HEIGHT / image.height) : 1;
	const sourceCanvas = createRasterCanvas(
		Math.max(1, Math.round(image.width * rasterScale)),
		Math.max(1, Math.round(image.height * rasterScale)),
	);
	const sourceCtx = get2d(sourceCanvas);
	if (!sourceCtx) {
		throw new Error(`No 2D context to rasterize cursor image: ${url.slice(0, 128)}`);
	}

	sourceCtx.clearRect(0, 0, sourceCanvas.width, sourceCanvas.height);
	sourceCtx.drawImage(image.source, 0, 0, sourceCanvas.width, sourceCanvas.height);

	if (options.preserveCanvas) {
		return {
			image: await toBitmap(sourceCanvas),
			aspectRatio: sourceCanvas.height > 0 ? sourceCanvas.width / sourceCanvas.height : 1,
			anchorX: clamp(anchor.x, 0, 1),
			anchorY: clamp(anchor.y, 0, 1),
		};
	}

	const trimmed = trimCanvasToAlpha(sourceCanvas, {
		x: sourceCanvas.width * clamp(anchor.x, 0, 1),
		y: sourceCanvas.height * clamp(anchor.y, 0, 1),
	});
	const trimmedImage = await toBitmap(trimmed.canvas);

	return {
		image: trimmedImage,
		aspectRatio: trimmed.height > 0 ? trimmed.width / trimmed.height : 1,
		anchorX:
			trimmed.hotspot && trimmed.width > 0
				? clamp(trimmed.hotspot.x / trimmed.width, 0, 1)
				: clamp(anchor.x, 0, 1),
		anchorY:
			trimmed.hotspot && trimmed.height > 0
				? clamp(trimmed.hotspot.y / trimmed.height, 0, 1)
				: clamp(anchor.y, 0, 1),
	};
}

function clamp(value: number, min: number, max: number) {
	return Math.min(max, Math.max(min, value));
}

function trimCanvasToAlpha(canvas: RasterCanvas, hotspot?: { x: number; y: number }) {
	const ctx = get2d(canvas);
	if (!ctx) {
		return {
			canvas,
			width: canvas.width,
			height: canvas.height,
			hotspot,
		};
	}

	const { width, height } = canvas;
	const imageData = ctx.getImageData(0, 0, width, height);
	const { data } = imageData;
	let minX = width;
	let minY = height;
	let maxX = -1;
	let maxY = -1;

	for (let y = 0; y < height; y += 1) {
		for (let x = 0; x < width; x += 1) {
			const alpha = data[(y * width + x) * 4 + 3];
			if (alpha === 0) {
				continue;
			}

			minX = Math.min(minX, x);
			minY = Math.min(minY, y);
			maxX = Math.max(maxX, x);
			maxY = Math.max(maxY, y);
		}
	}

	if (maxX < minX || maxY < minY) {
		return {
			canvas,
			width,
			height,
			hotspot,
		};
	}

	const croppedWidth = maxX - minX + 1;
	const croppedHeight = maxY - minY + 1;
	const croppedCanvas = createRasterCanvas(croppedWidth, croppedHeight);
	const croppedCtx = get2d(croppedCanvas)!;
	croppedCtx.drawImage(
		canvas,
		minX,
		minY,
		croppedWidth,
		croppedHeight,
		0,
		0,
		croppedWidth,
		croppedHeight,
	);

	return {
		canvas: croppedCanvas,
		width: croppedWidth,
		height: croppedHeight,
		hotspot: hotspot
			? {
					x: hotspot.x - minX,
					y: hotspot.y - minY,
				}
			: undefined,
	};
}

async function createInvertedCursorAsset(asset: LoadedCursorAsset): Promise<LoadedCursorAsset> {
	const canvas = createRasterCanvas(asset.image.width, asset.image.height);
	const ctx = get2d(canvas)!;
	ctx.drawImage(asset.image, 0, 0);
	const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
	const { data } = imageData;
	for (let index = 0; index < data.length; index += 4) {
		if (data[index + 3] === 0) {
			continue;
		}

		data[index] = 255 - data[index];
		data[index + 1] = 255 - data[index + 1];
		data[index + 2] = 255 - data[index + 2];
	}
	ctx.putImageData(imageData, 0, 0);

	const image = await toBitmap(canvas);

	return {
		image,
		aspectRatio: asset.aspectRatio,
		anchorX: asset.anchorX,
		anchorY: asset.anchorY,
	};
}

function getCursorAsset(key: CursorAssetKey): LoadedCursorAsset {
	const asset = loadedCursorAssets[key];
	if (!asset) {
		throw new Error(`Missing cursor asset for ${key}`);
	}

	return asset;
}

function getAvailableCursorKeys(): CursorAssetKey[] {
	const loadedKeys = Object.keys(loadedCursorAssets) as CursorAssetKey[];
	return loadedKeys.length > 0 ? loadedKeys : ["arrow"];
}

function getCursorStyleAsset(style: SingleCursorStyle) {
	const asset = loadedCursorStyleAssets[style];
	if (!asset) {
		throw new Error(`Missing cursor style asset for ${style}`);
	}

	return asset;
}

function getCursorPackStyleAsset(style: CursorPackStyle, key: CursorAssetKey) {
	const styleAssets = loadedCursorPackAssets[style];
	if (!styleAssets) {
		if (!warnedMissingCursorPackStyles.has(style)) {
			warnedMissingCursorPackStyles.add(style);
			console.warn(
				`[CursorRenderer] Missing cursor pack assets for ${style}; falling back to Tahoe cursors.`,
			);
		}
		return getStatefulCursorAsset("tahoe", key);
	}

	const variant = resolveCursorPackVariant(key);
	return styleAssets[variant] ?? styleAssets.default;
}

function getStatefulCursorAsset(style: StatefulCursorStyle, key: CursorAssetKey) {
	const assetMap = loadedCursorSetAssets[style] ?? loadedCursorAssets;
	const asset = assetMap[key] ?? assetMap.arrow;
	if (!asset) {
		throw new Error(`Missing ${style} cursor asset for ${key}`);
	}

	return asset;
}

async function ensureCursorPackAssetsLoaded() {
	const sources = getCursorPackSources();
	const signature = buildCursorPackSourcesSignature(sources);

	if (!cursorPackAssetsPromise || loadedCursorPackSourcesSignature !== signature) {
		loadedCursorPackSourcesSignature = signature;
		warnedMissingCursorPackStyles.clear();
		cursorPackAssetsPromise = (async () => {
			const cursorPackEntries = await Promise.all(
				Object.entries(sources).map(async ([style, source]) => {
					try {
						const [defaultAsset, pointerAsset] = await Promise.all([
							createCursorPackAsset(source.defaultUrl, source.defaultAnchor),
							createCursorPackAsset(source.pointerUrl, source.pointerAnchor),
						]);
						return [style, { default: defaultAsset, pointer: pointerAsset }] as const;
					} catch (error) {
						console.warn(
							`[CursorRenderer] Failed to load cursor pack style for: ${style}`,
							error,
						);
						return null;
					}
				}),
			);

			loadedCursorPackAssets = Object.fromEntries(
				cursorPackEntries.filter(Boolean).map((entry) => entry!),
			) as Partial<Record<string, LoadedCursorPackAssets>>;
		})();
	}

	await cursorPackAssetsPromise;
}

export async function preloadCursorAssets() {
	if (!cursorAssetsPromise) {
		cursorAssetsPromise = (async () => {
			async function loadCursorSet(
				style: keyof typeof cursorSetAssets,
			): Promise<Partial<Record<CursorAssetKey, LoadedCursorAsset>>> {
				const entries = await Promise.all(
					SUPPORTED_CURSOR_KEYS.map(async (key) => {
						const sourceAsset = cursorSetAssets[style][key];
						if (!sourceAsset?.url) {
							console.warn(`[CursorRenderer] No cursor image for: ${style}/${key}`);
							return null;
						}

						try {
							const asset = await createRasterizedCursorAsset(
								sourceAsset.url,
								sourceAsset.fallbackAnchor,
								{ preserveCanvas: sourceAsset.preserveCanvas },
							);

							return [key, asset] as const;
						} catch (error) {
							console.warn(
								`[CursorRenderer] Failed to load cursor image for: ${style}/${key}`,
								error,
							);
							return null;
						}
					}),
				);

				return Object.fromEntries(
					entries.filter(Boolean).map((entry) => entry!),
				) as Partial<Record<CursorAssetKey, LoadedCursorAsset>>;
			}

			const [macosAssets, tahoeAssets, windows11Assets] = await Promise.all([
				loadCursorSet("macos"),
				loadCursorSet("tahoe"),
				loadCursorSet("windows11"),
			]);

			const invertedEntries = await Promise.all(
				(Object.entries(tahoeAssets) as Array<[CursorAssetKey, LoadedCursorAsset]>).map(
					async ([key, asset]) => [key, await createInvertedCursorAsset(asset)] as const,
				),
			);

			loadedCursorSetAssets = {
				macos: macosAssets,
				tahoe: tahoeAssets,
				windows11: windows11Assets,
				"tahoe-inverted": Object.fromEntries(invertedEntries) as Partial<
					Record<CursorAssetKey, LoadedCursorAsset>
				>,
			};
			loadedCursorAssets = tahoeAssets;

			const customStyleEntries = await Promise.all(
				(["dot", "figma"] as const).map(
					async (style) => [style, await createCursorStyleAsset(style)] as const,
				),
			);

			loadedCursorStyleAssets = Object.fromEntries(customStyleEntries) as Partial<
				Record<SingleCursorStyle, LoadedCursorAsset>
			>;

			if (!loadedCursorAssets.arrow) {
				throw new Error("Failed to initialize the fallback arrow cursor asset");
			}
		})();
	}

	await cursorAssetsPromise;
	await ensureCursorPackAssetsLoaded();
}

/** glide: true once preloadCursorAssets() has resolved (drawing before that would throw). */
export function isCursorAssetsLoaded(): boolean {
	return Boolean(loadedCursorAssets.arrow) && Boolean(loadedCursorStyleAssets.figma);
}

function findLatestSample(samples: CursorTelemetryPoint[], timeMs: number) {
	if (samples.length === 0) return null;

	let lo = 0;
	let hi = samples.length - 1;
	while (lo < hi) {
		const mid = Math.ceil((lo + hi) / 2);
		if (samples[mid].timeMs <= timeMs) {
			lo = mid;
		} else {
			hi = mid - 1;
		}
	}

	return samples[lo]?.timeMs <= timeMs ? samples[lo] : null;
}

function findLatestInteractionSample(samples: CursorTelemetryPoint[], timeMs: number) {
	for (let index = samples.length - 1; index >= 0; index -= 1) {
		const sample = samples[index];
		if (sample.timeMs > timeMs) {
			continue;
		}

		if (
			sample.interactionType === "click" ||
			sample.interactionType === "double-click" ||
			sample.interactionType === "right-click" ||
			sample.interactionType === "middle-click"
		) {
			return sample;
		}
	}

	return null;
}

function findLatestStableCursorType(samples: CursorTelemetryPoint[], timeMs: number) {
	// Binary search to find position at timeMs, then scan backwards
	let lo = 0;
	let hi = samples.length - 1;
	while (lo < hi) {
		const mid = Math.ceil((lo + hi) / 2);
		if (samples[mid].timeMs <= timeMs) {
			lo = mid;
		} else {
			hi = mid - 1;
		}
	}

	// Scan backwards from the position to find a sample with cursorType
	// Skip click events only (not mouseup) to avoid transient re-type during clicks
	for (let index = lo; index >= 0; index -= 1) {
		const sample = samples[index];
		if (sample.timeMs > timeMs) {
			continue;
		}

		if (!sample.cursorType) {
			continue;
		}

		if (
			sample.interactionType === "click" ||
			sample.interactionType === "double-click" ||
			sample.interactionType === "right-click" ||
			sample.interactionType === "middle-click"
		) {
			continue;
		}

		return sample.cursorType;
	}

	return findLatestSample(samples, timeMs)?.cursorType ?? "arrow";
}

function getCursorSwaySpringConfig(smoothingFactor: number, springTuning: CursorSpringTuning) {
	const baseConfig = getCursorSpringConfig(
		Math.min(
			2,
			Math.max(
				0.15,
				smoothingFactor * CURSOR_SWAY_SMOOTHING_MULTIPLIER + CURSOR_SWAY_SMOOTHING_OFFSET,
			),
		),
		springTuning,
	);

	return {
		...baseConfig,
		damping: baseConfig.damping * 0.9,
		mass: Math.max(0.55, baseConfig.mass * 0.8),
		restDelta: 0.0005,
		restSpeed: 0.02,
	};
}

function getClickEffectColor(clickEffectColor: string) {
	const normalized = normalizeCursorClickEffectColor(clickEffectColor);
	return Number.parseInt(normalized.slice(1), 16);
}

function getExtensionStyleRippleMetrics(
	cursorSize: number,
	clickProgress: number,
	effectScale: number,
	effectOpacity: number,
) {
	const eased = 1 - Math.pow(clickProgress, 3);
	const fade = Math.pow(clickProgress, 3);

	return {
		radius: Math.max(0.5, eased * cursorSize * 1.95 * effectScale),
		alpha: Math.max(0, Math.min(1, fade * 0.6 * effectOpacity)),
		strokeWidth: Math.max(1, 2 * fade),
	};
}

export function drawClickEffectOnCanvas(
	ctx: Ctx2D,
	effect: CursorClickEffectStyle,
	px: number,
	py: number,
	cursorSize: number,
	clickProgress: number,
	effectScale: number,
	effectOpacity: number,
	effectColor: string = DEFAULT_CURSOR_CLICK_EFFECT_COLOR,
) {
	if (effect === "none" || clickProgress <= 0) {
		return;
	}

	const reveal = 1 - clickProgress;
	const alpha = clickProgress * effectOpacity;
	const color = getClickEffectColor(effectColor);
	const strokeColor = `rgba(${(color >> 16) & 255}, ${(color >> 8) & 255}, ${color & 255}, `;
	const baseRadius = Math.max(12, cursorSize * 0.55 * effectScale);
	const strokeWidth = Math.max(2, cursorSize * 0.08);

	ctx.save();

	if (effect === "ripple") {
		const ripple = getExtensionStyleRippleMetrics(
			cursorSize,
			clickProgress,
			effectScale,
			effectOpacity,
		);
		ctx.lineWidth = ripple.strokeWidth;
		ctx.strokeStyle = `${strokeColor}${ripple.alpha.toFixed(3)})`;
		ctx.beginPath();
		ctx.arc(px, py, ripple.radius, 0, Math.PI * 2);
		ctx.stroke();
		ctx.restore();
		return;
	}

	if (effect === "spotlight") {
		const glowRadius = baseRadius + reveal * cursorSize * effectScale;
		const innerRadius = Math.max(baseRadius * 0.72, glowRadius * 0.76);
		ctx.lineWidth = Math.max(1.25, strokeWidth * 0.68);
		ctx.strokeStyle = `${strokeColor}${(alpha * 0.28).toFixed(3)})`;
		ctx.beginPath();
		ctx.arc(px, py, glowRadius, 0, Math.PI * 2);
		ctx.stroke();
		ctx.lineWidth = Math.max(1.5, strokeWidth * 0.75);
		ctx.strokeStyle = `${strokeColor}${(alpha * 0.5).toFixed(3)})`;
		ctx.beginPath();
		ctx.arc(px, py, innerRadius, 0, Math.PI * 2);
		ctx.stroke();
		ctx.restore();
		return;
	}

	const echoOuterRadius = baseRadius + reveal * cursorSize * 1.22 * effectScale;
	const echoInnerRadius = Math.max(baseRadius * 0.58, echoOuterRadius * 0.62);
	ctx.lineWidth = strokeWidth;
	ctx.strokeStyle = `${strokeColor}${(alpha * 0.72).toFixed(3)})`;
	ctx.beginPath();
	ctx.arc(px, py, echoOuterRadius, 0, Math.PI * 2);
	ctx.stroke();
	ctx.lineWidth = Math.max(1.4, strokeWidth * 0.72);
	ctx.strokeStyle = `${strokeColor}${(alpha * 0.42).toFixed(3)})`;
	ctx.beginPath();
	ctx.arc(px, py, echoInnerRadius, 0, Math.PI * 2);
	ctx.stroke();
	ctx.fillStyle = `${strokeColor}${(alpha * 0.14).toFixed(3)})`;
	ctx.beginPath();
	ctx.arc(px, py, Math.max(3, baseRadius * 0.18), 0, Math.PI * 2);
	ctx.fill();
	ctx.restore();
}

export function getCursorVisualState(
	samples: CursorTelemetryPoint[],
	timeMs: number,
	clickBounceDuration: number,
	clickEffectDurationMs: number,
) {
	const latestClick = findLatestInteractionSample(samples, timeMs);
	const interactionType = latestClick?.interactionType;
	const ageMs = latestClick ? Math.max(0, timeMs - latestClick.timeMs) : Number.POSITIVE_INFINITY;
	const clickEffectDelayMs = clickBounceDuration * 0.5;
	const clickEffectAgeMs = ageMs - clickEffectDelayMs;
	const isClickEvent =
		interactionType === "click" ||
		interactionType === "double-click" ||
		interactionType === "right-click" ||
		interactionType === "middle-click";
	const clickBounceProgress =
		latestClick && isClickEvent && ageMs <= clickBounceDuration
			? 1 - ageMs / clickBounceDuration
			: 0;

	return {
		cursorType: findLatestStableCursorType(samples, timeMs),
		interactionType,
		clickSample: latestClick && isClickEvent ? latestClick : null,
		clickBounceProgress,
		clickProgress:
			latestClick &&
			isClickEvent &&
			clickEffectAgeMs >= 0 &&
			clickEffectAgeMs <= clickEffectDurationMs
				? 1 - clickEffectAgeMs / clickEffectDurationMs
				: 0,
	};
}

/**
 * Manages a smoothed cursor state that chases the interpolated target.
 */
export class SmoothedCursorState {
	public x = 0.5;
	public y = 0.5;
	public trail: Array<{ x: number; y: number }> = [];
	private smoothingFactor: number;
	private springTuning: CursorSpringTuning;
	private trailLength: number;
	private initialized = false;
	private lastTimeMs: number | null = null;
	private xSpring = createSpringState(0.5);
	private ySpring = createSpringState(0.5);

	constructor(
		config: Pick<CursorRenderConfig, "smoothingFactor" | "trailLength" | "springTuning">,
	) {
		this.smoothingFactor = config.smoothingFactor;
		this.springTuning = config.springTuning;
		this.trailLength = config.trailLength;
	}

	update(targetX: number, targetY: number, timeMs: number): void {
		if (!this.initialized) {
			this.x = targetX;
			this.y = targetY;
			this.initialized = true;
			this.lastTimeMs = timeMs;
			this.xSpring.value = targetX;
			this.ySpring.value = targetY;
			this.xSpring.velocity = 0;
			this.ySpring.velocity = 0;
			this.xSpring.initialized = true;
			this.ySpring.initialized = true;
			this.trail = [];
			return;
		}

		if (this.smoothingFactor <= 0 || (this.lastTimeMs !== null && timeMs < this.lastTimeMs)) {
			this.snapTo(targetX, targetY, timeMs);
			return;
		}

		this.trail.unshift({ x: this.x, y: this.y });
		if (this.trail.length > this.trailLength) {
			this.trail.length = this.trailLength;
		}

		const deltaMs =
			this.lastTimeMs === null ? 1000 / 60 : Math.max(1, timeMs - this.lastTimeMs);
		this.lastTimeMs = timeMs;

		const springConfig = getCursorSpringConfig(this.smoothingFactor, this.springTuning);
		this.x = stepSpringValue(this.xSpring, targetX, deltaMs, springConfig);
		this.y = stepSpringValue(this.ySpring, targetY, deltaMs, springConfig);
	}

	setSmoothingFactor(smoothingFactor: number): void {
		this.smoothingFactor = smoothingFactor;
	}

	setSpringTuning(springTuning: CursorSpringTuning): void {
		this.springTuning = springTuning;
	}

	snapTo(targetX: number, targetY: number, timeMs: number): void {
		this.x = targetX;
		this.y = targetY;
		this.initialized = true;
		this.lastTimeMs = timeMs;
		this.xSpring.value = targetX;
		this.ySpring.value = targetY;
		this.xSpring.velocity = 0;
		this.ySpring.velocity = 0;
		this.xSpring.initialized = true;
		this.ySpring.initialized = true;
		this.trail = [];
	}

	reset(): void {
		this.initialized = false;
		this.lastTimeMs = null;
		this.trail = [];
		resetSpringState(this.xSpring, this.x);
		resetSpringState(this.ySpring, this.y);
	}
}

// ---- glide: Canvas 2D port of PixiCursorOverlay (Recordly L1083-1610) -------------------------
// frameRenderer (export) drives PixiCursorOverlay.update(samples, t, maskRect, showCursor, false)
// once per frame inside the camera container. This class keeps the exact same per-frame state
// machine (spring-smoothed position, >100 ms discontinuity snap, click bounce, sway spring, click
// effect anchored at the click sample) but paints into a 2D context instead of positioning Pixi
// sprites. Sprite rotation about its anchor becomes translate(px,py)+rotate(); the separate tinted,
// blurred shadow sprite (alpha 0.35, offset 0/2, blur 3) becomes Recordly's own canvas drop-shadow
// filter (CURSOR_SVG_DROP_SHADOW_FILTER, the one drawCursorOnCanvas uses). Motion blur is not
// ported (Pixi MotionBlurFilter; out of scope, see PLAN blockers #4).
export class CanvasCursorOverlay {
	private state: SmoothedCursorState;
	private config: CursorRenderConfig;
	private lastRenderedPoint: { px: number; py: number } | null = null;
	private lastRenderedTimeMs: number | null = null;
	private cursorVisible = false;
	private swayRotation = 0;
	private swaySpring = createSpringState(0);

	constructor(config: Partial<CursorRenderConfig> = {}) {
		this.config = {
			...DEFAULT_CURSOR_CONFIG,
			...config,
			springTuning: {
				...DEFAULT_CURSOR_CONFIG.springTuning,
				...config.springTuning,
			},
		};
		this.state = new SmoothedCursorState(this.config);
	}

	setDotRadius(dotRadius: number) {
		this.config.dotRadius = dotRadius;
	}

	setSmoothingFactor(smoothingFactor: number) {
		this.config.smoothingFactor = smoothingFactor;
		this.state.setSmoothingFactor(smoothingFactor);
	}

	setSpringTuning(springTuning: CursorSpringTuning) {
		this.config.springTuning = {
			...DEFAULT_CURSOR_CONFIG.springTuning,
			...springTuning,
		};
		this.state.setSpringTuning(this.config.springTuning);
	}

	setClickBounce(clickBounce: number) {
		this.config.clickBounce = Math.max(0, clickBounce);
	}

	setClickEffect(clickEffect: CursorClickEffectStyle) {
		this.config.clickEffect = clickEffect;
	}

	setClickEffectColor(clickEffectColor: string) {
		this.config.clickEffectColor = normalizeCursorClickEffectColor(clickEffectColor);
	}

	setClickEffectScale(clickEffectScale: number) {
		this.config.clickEffectScale = clamp(clickEffectScale, 0.5, 2);
	}

	setClickEffectOpacity(clickEffectOpacity: number) {
		this.config.clickEffectOpacity = clamp(clickEffectOpacity, 0, 1);
	}

	setClickEffectDurationMs(clickEffectDurationMs: number) {
		this.config.clickEffectDurationMs = clamp(clickEffectDurationMs, 120, 1200);
	}

	setClickBounceDuration(clickBounceDuration: number) {
		this.config.clickBounceDuration = clamp(clickBounceDuration, 60, 500);
	}

	setSway(sway: number) {
		this.config.sway = clamp(sway, 0, 2);
	}

	setStyle(style: CursorStyle) {
		this.config.style = style;
	}

	getSmoothedCursorSnapshot(): {
		cx: number;
		cy: number;
		trail: Array<{ cx: number; cy: number }>;
	} | null {
		if (!this.cursorVisible) {
			return null;
		}

		return {
			cx: this.state.x,
			cy: this.state.y,
			trail: this.state.trail.map((point) => ({ cx: point.x, cy: point.y })),
		};
	}

	/** Last sway rotation in radians (exposed for tests). */
	getSwayRotation(): number {
		return this.swayRotation;
	}

	update(
		ctx: Ctx2D,
		samples: CursorTelemetryPoint[],
		timeMs: number,
		viewport: CursorViewportRect,
		visible: boolean,
		freeze = false,
	): void {
		if (samples.length === 0 || viewport.width <= 0 || viewport.height <= 0) {
			this.cursorVisible = false;
			this.lastRenderedPoint = null;
			this.lastRenderedTimeMs = null;
			this.swayRotation = 0;
			resetSpringState(this.swaySpring, 0);
			return;
		}

		const target = interpolateCursorPosition(samples, timeMs);
		if (!target) {
			this.cursorVisible = false;
			return;
		}

		const projectedTarget = projectCursorPositionToViewport(target, viewport.sourceCrop);

		const h =
			this.config.dotRadius *
			getCursorViewportScale(viewport.width, this.config.minViewportScale);
		const { cursorType, clickSample, clickBounceProgress, clickProgress } =
			getCursorVisualState(
				samples,
				timeMs,
				this.config.clickBounceDuration,
				this.config.clickEffectDurationMs,
			);
		const projectedClickSample = clickSample
			? projectCursorPositionToViewport(clickSample, viewport.sourceCrop)
			: null;
		const clickEffectPx =
			projectedClickSample && projectedClickSample.visible
				? viewport.x + projectedClickSample.cx * viewport.width
				: viewport.x + projectedTarget.cx * viewport.width;
		const clickEffectPy =
			projectedClickSample && projectedClickSample.visible
				? viewport.y + projectedClickSample.cy * viewport.height
				: viewport.y + projectedTarget.cy * viewport.height;
		const shouldShowCursorSprite = visible && projectedTarget.visible;
		const shouldDrawClickEffect =
			this.config.clickEffect !== "none" &&
			clickProgress > 0 &&
			Boolean(projectedClickSample?.visible);

		if (!shouldShowCursorSprite && !shouldDrawClickEffect) {
			this.cursorVisible = false;
			this.lastRenderedPoint = null;
			this.lastRenderedTimeMs = null;
			this.swayRotation = 0;
			resetSpringState(this.swaySpring, 0);
			return;
		}

		this.cursorVisible = shouldShowCursorSprite;

		let px = viewport.x + projectedTarget.cx * viewport.width;
		let py = viewport.y + projectedTarget.cy * viewport.height;
		let shouldFreezeCursorMotion = true;

		if (shouldShowCursorSprite) {
			const sameFrameTime =
				this.lastRenderedTimeMs !== null &&
				Math.abs(this.lastRenderedTimeMs - timeMs) < 0.0001;
			const hasTimeDiscontinuity =
				this.lastRenderedTimeMs !== null &&
				Math.abs(timeMs - this.lastRenderedTimeMs) > CURSOR_TIME_DISCONTINUITY_MS;
			shouldFreezeCursorMotion = freeze || hasTimeDiscontinuity;

			if (shouldFreezeCursorMotion) {
				if (!sameFrameTime || !this.lastRenderedPoint) {
					this.state.snapTo(projectedTarget.cx, projectedTarget.cy, timeMs);
				}
			} else {
				this.state.update(projectedTarget.cx, projectedTarget.cy, timeMs);
			}

			px = viewport.x + this.state.x * viewport.width;
			py = viewport.y + this.state.y * viewport.height;
		}

		const bounceScale = Math.max(
			0.72,
			1 - Math.sin(clickBounceProgress * Math.PI) * (0.08 * this.config.clickBounce),
		);
		const scaledH = h * getCursorStyleSizeMultiplier(this.config.style);
		const swayRotation = this.updateCursorSway(px, py, timeMs, shouldFreezeCursorMotion);

		// Pixi z-order: click ring graphics first, then shadow sprite, then cursor sprite.
		drawClickEffectOnCanvas(
			ctx,
			this.config.clickEffect,
			clickEffectPx,
			clickEffectPy,
			scaledH,
			clickProgress,
			this.config.clickEffectScale,
			this.config.clickEffectOpacity,
			this.config.clickEffectColor,
		);

		if (shouldShowCursorSprite) {
			const spriteKey = (
				cursorType && loadedCursorAssets[cursorType] ? cursorType : "arrow"
			) as CursorAssetKey;
			const asset = isStatefulCursorStyle(this.config.style)
				? getStatefulCursorAsset(this.config.style, spriteKey)
				: isSingleCursorStyle(this.config.style)
					? getCursorStyleAsset(this.config.style)
					: getCursorPackStyleAsset(this.config.style, spriteKey);
			const drawHeight = scaledH * bounceScale;
			const drawWidth = drawHeight * asset.aspectRatio;

			ctx.save();
			if (this.config.style !== "figma") {
				ctx.filter = CURSOR_SVG_DROP_SHADOW_FILTER;
			}
			ctx.globalAlpha = this.config.dotAlpha;
			ctx.translate(px, py);
			if (swayRotation !== 0) {
				ctx.rotate(swayRotation);
			}
			ctx.drawImage(
				asset.image,
				-asset.anchorX * drawWidth,
				-asset.anchorY * drawHeight,
				drawWidth,
				drawHeight,
			);
			ctx.restore();
		}

		this.lastRenderedPoint = shouldShowCursorSprite ? { px, py } : null;
		this.lastRenderedTimeMs = timeMs;
	}

	private updateCursorSway(px: number, py: number, timeMs: number, freeze: boolean) {
		const deltaMs =
			this.lastRenderedTimeMs === null || freeze
				? 1000 / 60
				: Math.max(1, timeMs - this.lastRenderedTimeMs);
		const targetRotation =
			!freeze && this.lastRenderedPoint && this.lastRenderedTimeMs !== null
				? computeCursorSwayRotation(
						px - this.lastRenderedPoint.px,
						py - this.lastRenderedPoint.py,
						timeMs - this.lastRenderedTimeMs,
						this.config.sway,
					)
				: 0;

		this.swayRotation = stepSpringValue(
			this.swaySpring,
			targetRotation,
			deltaMs,
			getCursorSwaySpringConfig(this.config.smoothingFactor, this.config.springTuning),
		);

		if (Math.abs(this.swayRotation) < 0.0001 && targetRotation === 0) {
			this.swayRotation = 0;
		}

		return this.swayRotation;
	}

	reset(): void {
		this.state.reset();
		this.cursorVisible = false;
		this.lastRenderedPoint = null;
		this.lastRenderedTimeMs = null;
		this.swayRotation = 0;
		resetSpringState(this.swaySpring, 0);
	}
}

export function drawCursorOnCanvas(
	ctx: Ctx2D,
	samples: CursorTelemetryPoint[],
	timeMs: number,
	viewport: CursorViewportRect,
	smoothedState: SmoothedCursorState,
	config: CursorRenderConfig = DEFAULT_CURSOR_CONFIG,
): void {
	if (samples.length === 0 || viewport.width <= 0 || viewport.height <= 0) return;

	const target = interpolateCursorPosition(samples, timeMs);
	if (!target) return;

	const projectedTarget = projectCursorPositionToViewport(target, viewport.sourceCrop);
	if (!projectedTarget.visible) return;

	smoothedState.update(projectedTarget.cx, projectedTarget.cy, timeMs);

	const px = viewport.x + smoothedState.x * viewport.width;
	const py = viewport.y + smoothedState.y * viewport.height;
	const h = config.dotRadius * getCursorViewportScale(viewport.width, config.minViewportScale);
	const { cursorType, clickSample, clickBounceProgress, clickProgress } = getCursorVisualState(
		samples,
		timeMs,
		config.clickBounceDuration,
		config.clickEffectDurationMs,
	);
	const projectedClickSample = clickSample
		? projectCursorPositionToViewport(clickSample, viewport.sourceCrop)
		: null;
	const clickEffectPx =
		projectedClickSample && projectedClickSample.visible
			? viewport.x + projectedClickSample.cx * viewport.width
			: px;
	const clickEffectPy =
		projectedClickSample && projectedClickSample.visible
			? viewport.y + projectedClickSample.cy * viewport.height
			: py;
	const spriteKey = (
		cursorType && loadedCursorAssets[cursorType] ? cursorType : "arrow"
	) as CursorAssetKey;
	const asset = isStatefulCursorStyle(config.style)
		? getStatefulCursorAsset(config.style, spriteKey)
		: isSingleCursorStyle(config.style)
			? getCursorStyleAsset(config.style)
			: getCursorPackStyleAsset(config.style, spriteKey);
	const bounceScale = Math.max(
		0.72,
		1 - Math.sin(clickBounceProgress * Math.PI) * (0.08 * config.clickBounce),
	);
	const effectHeight = h * getCursorStyleSizeMultiplier(config.style);
	const drawHeight = effectHeight * bounceScale;
	drawClickEffectOnCanvas(
		ctx,
		config.clickEffect,
		clickEffectPx,
		clickEffectPy,
		effectHeight,
		clickProgress,
		config.clickEffectScale,
		config.clickEffectOpacity,
		config.clickEffectColor,
	);

	ctx.save();
	if (config.style !== "figma") {
		ctx.filter = CURSOR_SVG_DROP_SHADOW_FILTER;
	}

	const drawWidth = drawHeight * asset.aspectRatio;
	const hotspotX = asset.anchorX * drawWidth;
	const hotspotY = asset.anchorY * drawHeight;
	ctx.globalAlpha = config.dotAlpha;
	ctx.drawImage(asset.image, px - hotspotX, py - hotspotY, drawWidth, drawHeight);

	ctx.restore();
}
