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

// ---------------------------------------------------------------------------------------------
// LEGACY (temporary): the pre-port renderer, kept only so the current main.ts / export.ts still build
// until P5 rewires them to the RenderFrameInput contract. P5 deletes this block. Types are structural on
// purpose so P1's camera.ts rewrite and P5's settings.ts rewrite don't break it.

type LegacySrc = CanvasImageSource & { videoWidth?: number; videoHeight?: number; width?: number | SVGAnimatedLength; height?: number | SVGAnimatedLength };

/** @deprecated Old input shape used by the pre-port main.ts / export.ts. */
export interface LegacyRenderInput {
	screen: LegacySrc | null;
	camera: LegacySrc | null;
	bgImage: CanvasImageSource | null;
	cam: { view: { x: number; y: number; w: number; h: number }; scale: number; cursor: { cx: number; cy: number; style: string; pressed: boolean } | null };
	track: { clicks: { t: number; x: number; y: number }[] };
	t: number;
	settings: {
		background: { kind: "gradient"; stops: string[] } | { kind: "color"; color: string } | { kind: "image"; url: string };
		padding: number;
		radius: number;
		shadow: number;
		cursor: { draw: boolean; size: number; ripple: boolean };
		webcam: { show: boolean; size: number; corner: string; mirror: boolean; shape: "circle" | "rounded" };
	};
}

const legacyDims = (s: LegacySrc): [number, number] => {
	if (typeof s.videoWidth === "number" && s.videoWidth) return [s.videoWidth, s.videoHeight ?? 0];
	return [Number(s.width) || 0, Number(s.height) || 0];
};
const easeOutCubic = (t: number) => 1 - (1 - t) ** 3;

function legacyRoundRect(ctx: Ctx2D, x: number, y: number, w: number, h: number, r: number) {
	ctx.beginPath();
	ctx.roundRect(x, y, w, h, r);
}

function legacyBackground(ctx: Ctx2D, W: number, H: number, s: LegacyRenderInput["settings"], img: CanvasImageSource | null) {
	const bg = s.background;
	if (bg.kind === "image" && img) {
		const [iw, ih] = legacyDims(img as LegacySrc);
		const k = Math.max(W / iw, H / ih);
		ctx.drawImage(img, (W - iw * k) / 2, (H - ih * k) / 2, iw * k, ih * k);
		return;
	}
	if (bg.kind === "color") {
		ctx.fillStyle = bg.color;
		ctx.fillRect(0, 0, W, H);
		return;
	}
	const stops = bg.kind === "gradient" ? bg.stops : ["#111", "#333"];
	const g = ctx.createLinearGradient(0, 0, W, H);
	stops.forEach((c, i) => g.addColorStop(i / Math.max(1, stops.length - 1), c));
	ctx.fillStyle = g;
	ctx.fillRect(0, 0, W, H);
}

function legacyCursor(ctx: Ctx2D, x: number, y: number, k: number, style: string, pressed: boolean) {
	ctx.save();
	ctx.translate(x, y);
	const s = k * (pressed ? 0.85 : 1);
	ctx.scale(s, s);
	ctx.shadowColor = "rgba(0,0,0,0.35)";
	ctx.shadowBlur = 6;
	ctx.shadowOffsetY = 2;
	ctx.lineJoin = "round";
	if (style === "text") {
		ctx.strokeStyle = "#111";
		ctx.lineWidth = 4.5;
		ctx.beginPath();
		ctx.moveTo(-5, -11); ctx.lineTo(5, -11); ctx.moveTo(0, -11); ctx.lineTo(0, 11); ctx.moveTo(-5, 11); ctx.lineTo(5, 11);
		ctx.stroke();
		ctx.strokeStyle = "#fff";
		ctx.lineWidth = 2;
		ctx.stroke();
	} else {
		ctx.beginPath();
		ctx.moveTo(0, 0); ctx.lineTo(0, 22); ctx.lineTo(5.5, 17); ctx.lineTo(9.5, 26); ctx.lineTo(13, 24.5); ctx.lineTo(9, 15.5); ctx.lineTo(16, 15.5);
		ctx.closePath();
		ctx.fillStyle = "#111";
		ctx.strokeStyle = "#fff";
		ctx.lineWidth = 2;
		ctx.stroke();
		ctx.fill();
		if (style === "pointer") {
			ctx.beginPath();
			ctx.arc(18, 4, 3, 0, Math.PI * 2);
			ctx.fillStyle = "#3b82f6";
			ctx.fill();
		}
	}
	ctx.restore();
}

function renderLegacy(ctx: Ctx2D, W: number, H: number, inp: LegacyRenderInput) {
	const { settings: s, cam } = inp;
	const unit = Math.min(W, H) / 1080;
	ctx.save();
	ctx.clearRect(0, 0, W, H);
	legacyBackground(ctx, W, H, s, inp.bgImage);
	const pad = Math.min(W, H) * s.padding;
	const [sw, sh] = inp.screen ? legacyDims(inp.screen) : [16, 9];
	const k = Math.min((W - pad * 2) / sw, (H - pad * 2) / sh);
	const dw = sw * k;
	const dh = sh * k;
	const dx = (W - dw) / 2;
	const dy = (H - dh) / 2;
	const r = s.radius * unit;
	if (s.shadow > 0) {
		ctx.save();
		ctx.shadowColor = `rgba(0,0,0,${0.55 * s.shadow})`;
		ctx.shadowBlur = 60 * unit * s.shadow;
		ctx.shadowOffsetY = 18 * unit * s.shadow;
		legacyRoundRect(ctx, dx, dy, dw, dh, r);
		ctx.fillStyle = "#000";
		ctx.fill();
		ctx.restore();
	}
	ctx.save();
	legacyRoundRect(ctx, dx, dy, dw, dh, r);
	ctx.clip();
	if (inp.screen && sw && sh) {
		const v = cam.view;
		ctx.imageSmoothingQuality = "high";
		ctx.drawImage(inp.screen, v.x * sw, v.y * sh, v.w * sw, v.h * sh, dx, dy, dw, dh);
	} else {
		ctx.fillStyle = "#000";
		ctx.fillRect(dx, dy, dw, dh);
	}
	const map = (nx: number, ny: number): [number, number] => [dx + ((nx - cam.view.x) / cam.view.w) * dw, dy + ((ny - cam.view.y) / cam.view.h) * dh];
	if (s.cursor.ripple) {
		for (const c of inp.track.clicks) {
			const age = inp.t - c.t;
			if (age < 0 || age > 550) continue;
			const p = easeOutCubic(age / 550);
			const [x, y] = map(c.x, c.y);
			ctx.beginPath();
			ctx.arc(x, y, (10 + 34 * p) * unit * cam.scale ** 0.5, 0, Math.PI * 2);
			ctx.fillStyle = `rgba(59,130,246,${0.35 * (1 - p)})`;
			ctx.fill();
			ctx.lineWidth = 2.5 * unit;
			ctx.strokeStyle = `rgba(255,255,255,${0.8 * (1 - p)})`;
			ctx.stroke();
		}
	}
	if (s.cursor.draw && cam.cursor) {
		const [x, y] = map(cam.cursor.cx, cam.cursor.cy);
		legacyCursor(ctx, x, y, 1.6 * unit * s.cursor.size * cam.scale ** 0.35, cam.cursor.style, cam.cursor.pressed);
	}
	ctx.restore();
	if (s.webcam.show && inp.camera) {
		const [cw, ch] = legacyDims(inp.camera);
		if (cw && ch) {
			const size = Math.min(W, H) * s.webcam.size;
			const margin = Math.max(pad * 0.5, 24 * unit);
			const bx = s.webcam.corner.endsWith("r") ? W - margin - size : margin;
			const by = s.webcam.corner.startsWith("b") ? H - margin - size : margin;
			const br = s.webcam.shape === "circle" ? size / 2 : size * 0.18;
			ctx.save();
			ctx.shadowColor = "rgba(0,0,0,0.45)";
			ctx.shadowBlur = 30 * unit;
			ctx.shadowOffsetY = 10 * unit;
			legacyRoundRect(ctx, bx, by, size, size, br);
			ctx.fillStyle = "#111";
			ctx.fill();
			ctx.restore();
			ctx.save();
			legacyRoundRect(ctx, bx, by, size, size, br);
			ctx.clip();
			const side = Math.min(cw, ch);
			const sx = (cw - side) / 2;
			const sy = (ch - side) / 2;
			if (s.webcam.mirror) {
				ctx.translate(bx + size, by);
				ctx.scale(-1, 1);
				ctx.drawImage(inp.camera, sx, sy, side, side, 0, 0, size, size);
			} else ctx.drawImage(inp.camera, sx, sy, side, side, bx, by, size, size);
			ctx.restore();
			legacyRoundRect(ctx, bx, by, size, size, br);
			ctx.lineWidth = 4 * unit;
			ctx.strokeStyle = "rgba(255,255,255,0.9)";
			ctx.stroke();
		}
	}
	ctx.restore();
}

// ---------------------------------------------------------------------------------------------

/** Contract entry point (PLAN.md). Accepts the legacy input shape until P5 switches the callers. */
export function renderFrame(ctx: Ctx2D, W: number, H: number, inp: RenderFrameInput | LegacyRenderInput): void {
	if ("style" in inp) renderScene(ctx, W, H, inp);
	else renderLegacy(ctx, W, H, inp);
}
