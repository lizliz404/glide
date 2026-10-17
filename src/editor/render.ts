// Compositor shared by live preview and export, so what you see is what you export.
// Mirrors Recordly's FrameRenderer (src/lib/exporter/frameRenderer.ts): a static background canvas
// (setupBackground), a camera-transformed video layer clipped by the squircle mask (the Pixi
// cameraContainer with layoutVideoContent's mask), composited with sceneEffects' stacked drop-shadows
// (compositeWithShadows ≈L1679), and the webcam bubble drawn last, outside the camera transform.
import { getSquirclePathPoints } from "../vendor/recordly/squircle";
import { getSceneEffectMetrics, type SceneEffectMetrics } from "../vendor/recordly/sceneEffects";
import { configureHighQuality2DContext, paintWallpaper } from "../vendor/recordly/wallpaperFill";
import { backgroundToWallpaper, computeFrameLayout, type FrameLayout, type FrameStyle, type Rect } from "./frame";

export type Ctx2D = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;
type AnyCanvas = HTMLCanvasElement | OffscreenCanvas;

/** Structural subset of P1's CameraTransform (computeZoomTransform output in stage px). */
export interface RenderCamera {
	scale: number;
	x: number;
	y: number;
	zoomScale: number;
}

export const IDENTITY_CAMERA: RenderCamera = { scale: 1, x: 0, y: 0, zoomScale: 1 };

export interface RenderFrameInput {
	screen: CanvasImageSource | null;
	videoW: number;
	videoH: number;
	bgImage: CanvasImageSource | null;
	style: FrameStyle;
	camera: RenderCamera;
	/** Called INSIDE the camera transform with the mask rect (stage px, pre-zoom). */
	drawCursor?: (ctx: Ctx2D, viewport: Rect) => void;
	/** Called last, outside the camera transform. */
	drawWebcam?: (ctx: Ctx2D, W: number, H: number, zoomScale: number) => void;
}

// ---------------------------------------------------------------------------------------------
// Scratch surfaces, one set per destination context so preview and export never thrash each other.

interface Scratch {
	bg: AnyCanvas;
	bgCtx: Ctx2D;
	bgKey: string;
	bgImage: CanvasImageSource | null;
	layer: AnyCanvas;
	layerCtx: Ctx2D;
	clip: Path2D | null;
	clipKey: string;
	/** Memoised per-frame inputs (compared by value) so steady-state frames allocate nothing. */
	bgKind: string;
	fxKey: [number, number, number];
	fx: SceneEffectMetrics | null;
	layoutKey: [number, number, number, number, number, number];
	layout: FrameLayout | null;
}

const scratchByCtx = new WeakMap<object, Scratch>();

function makeCanvas(w: number, h: number): AnyCanvas {
	if (typeof OffscreenCanvas !== "undefined") return new OffscreenCanvas(w, h);
	const c = document.createElement("canvas");
	c.width = w;
	c.height = h;
	return c;
}

function get2d(c: AnyCanvas): Ctx2D {
	const ctx = (c as OffscreenCanvas).getContext("2d") as Ctx2D | null;
	if (!ctx) throw new Error("Failed to get 2D context");
	return configureHighQuality2DContext(ctx);
}

function scratchFor(ctx: Ctx2D, W: number, H: number): Scratch {
	let s = scratchByCtx.get(ctx);
	if (!s) {
		const bg = makeCanvas(W, H);
		const layer = makeCanvas(W, H);
		s = {
			bg, bgCtx: get2d(bg), bgKey: "", bgImage: null, layer, layerCtx: get2d(layer), clip: null, clipKey: "",
			bgKind: "", fxKey: [NaN, NaN, NaN], fx: null, layoutKey: [NaN, NaN, NaN, NaN, NaN, NaN], layout: null,
		};
		scratchByCtx.set(ctx, s);
	}
	if (s.bg.width !== W || s.bg.height !== H) {
		s.bg.width = W;
		s.bg.height = H;
		s.layer.width = W;
		s.layer.height = H;
		// Resizing resets context state.
		configureHighQuality2DContext(s.bgCtx);
		configureHighQuality2DContext(s.layerCtx);
		s.bgKey = "";
		s.clipKey = "";
	}
	return s;
}

function sourceSize(src: CanvasImageSource): [number, number] {
	const v = src as { videoWidth?: number; videoHeight?: number; naturalWidth?: number; naturalHeight?: number; displayWidth?: number; displayHeight?: number; width?: unknown; height?: unknown };
	if (v.videoWidth) return [v.videoWidth, v.videoHeight ?? 0];
	if (v.naturalWidth) return [v.naturalWidth, v.naturalHeight ?? 0];
	if (v.displayWidth) return [v.displayWidth, v.displayHeight ?? 0];
	return [Number(v.width) || 0, Number(v.height) || 0];
}

/** setupBackground: repaint the static background only when its inputs change (no per-frame strings). */
function ensureBackground(s: Scratch, W: number, H: number, style: FrameStyle, img: CanvasImageSource | null) {
	const wallpaper = backgroundToWallpaper(style.background);
	const kind = style.background.kind;
	if (s.bgKey === wallpaper && s.bgKind === kind && img === s.bgImage) return;
	s.bgKey = wallpaper;
	s.bgKind = kind;
	s.bgImage = img;
	const ctx = s.bgCtx;
	ctx.clearRect(0, 0, W, H);
	if (kind === "image") {
		const [iw, ih] = img ? sourceSize(img) : [0, 0];
		if (!img || !iw || !ih) {
			// Still loading (or failed): Recordly's black fallback, without logging every load.
			ctx.fillStyle = "#000000";
			ctx.fillRect(0, 0, W, H);
			return;
		}
		paintWallpaper(ctx, W, H, wallpaper, { width: iw, height: ih, source: img });
		return;
	}
	paintWallpaper(ctx, W, H, wallpaper, null);
}

/** layoutVideoContent's mask, cached as a Path2D (stage coords; the camera transform is applied on top). */
function ensureClip(s: Scratch, mask: Rect, radius: number): Path2D {
	const key = `${mask.x},${mask.y},${mask.width},${mask.height},${radius}`;
	if (s.clip && key === s.clipKey) return s.clip;
	const p = new Path2D();
	const pts = getSquirclePathPoints({ ...mask, radius });
	if (pts.length) {
		p.moveTo(pts[0].x, pts[0].y);
		for (let i = 1; i < pts.length; i++) p.lineTo(pts[i].x, pts[i].y);
		p.closePath();
	} else p.rect(mask.x, mask.y, mask.width, mask.height);
	s.clip = p;
	s.clipKey = key;
	return p;
}

function renderScene(ctx: Ctx2D, W: number, H: number, inp: RenderFrameInput): void {
	const { style, camera } = inp;
	const s = scratchFor(ctx, W, H);
	const fk = s.fxKey;
	if (!s.fx || fk[0] !== W || fk[1] !== style.backgroundBlur || fk[2] !== style.shadowIntensity) {
		fk[0] = W;
		fk[1] = style.backgroundBlur;
		fk[2] = style.shadowIntensity;
		s.fx = getSceneEffectMetrics({
			viewportWidth: W,
			backgroundBlur: style.backgroundBlur,
			shadowIntensity: style.shadowIntensity,
		});
	}
	const sceneEffects = s.fx;

	ctx.save();
	ctx.setTransform(1, 0, 0, 1, 0, 0);
	ctx.clearRect(0, 0, W, H);
	ctx.imageSmoothingEnabled = true;
	ctx.imageSmoothingQuality = "high";

	// Step 1: background layer (optional blur, not affected by zoom).
	ensureBackground(s, W, H, style, inp.bgImage);
	if (sceneEffects.backgroundBlurPx > 0) {
		ctx.save();
		const overscan = sceneEffects.backgroundOverscanPx;
		ctx.filter = `blur(${sceneEffects.backgroundBlurPx}px)`;
		ctx.drawImage(s.bg, -overscan, -overscan, W + overscan * 2, H + overscan * 2);
		ctx.restore();
	} else {
		ctx.drawImage(s.bg, 0, 0, W, H);
	}

	// Step 2: video layer = Pixi cameraContainer (scale + position) holding the masked video and cursor.
	const vw = inp.videoW || 16;
	const vh = inp.videoH || 9;
	const lk = s.layoutKey;
	if (!s.layout || lk[0] !== W || lk[1] !== H || lk[2] !== vw || lk[3] !== vh || lk[4] !== style.padding || lk[5] !== style.borderRadius) {
		lk[0] = W; lk[1] = H; lk[2] = vw; lk[3] = vh; lk[4] = style.padding; lk[5] = style.borderRadius;
		s.layout = computeFrameLayout(W, H, vw, vh, style);
	}
	const layout = s.layout;
	const lc = s.layerCtx;
	lc.setTransform(1, 0, 0, 1, 0, 0);
	lc.clearRect(0, 0, W, H);
	lc.save();
	lc.setTransform(camera.scale, 0, 0, camera.scale, camera.x, camera.y);
	lc.save();
	lc.clip(ensureClip(s, layout.mask, layout.radiusPx));
	if (inp.screen && inp.videoW && inp.videoH) {
		lc.drawImage(inp.screen, layout.sprite.x, layout.sprite.y, layout.sprite.width, layout.sprite.height);
	}
	lc.restore();
	inp.drawCursor?.(lc, layout.mask);
	lc.restore();

	// Step 3: composite the video layer with the stacked drop-shadows.
	if (style.shadowIntensity > 0) {
		ctx.save();
		ctx.filter = sceneEffects.shadowFilter;
		ctx.drawImage(s.layer, 0, 0, W, H);
		ctx.restore();
	} else {
		ctx.drawImage(s.layer, 0, 0, W, H);
	}

	// Step 4: webcam bubble on top, outside the camera transform.
	inp.drawWebcam?.(ctx, W, H, camera.zoomScale);
	ctx.restore();
}

/** Contract entry point (PLAN.md): one composited frame, shared by preview and export. */
export function renderFrame(ctx: Ctx2D, W: number, H: number, inp: RenderFrameInput): void {
	renderScene(ctx, W, H, inp);
}
