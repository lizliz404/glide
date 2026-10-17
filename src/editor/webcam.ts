// Glide webcam bubble. Geometry, defaults and drawing mirror Recordly @ e4a9d04:
//   defaults  -> src/components/video-editor/types.ts (DEFAULT_WEBCAM_*)
//   drawing   -> src/lib/exporter/frameRenderer.ts ≈L1823–1945 (bubble canvas, squircle clip, mirror, shadow)
// Glide's contract has a single sizePercent (Recordly's `size`, used for width and height).
import type { CropRegion, WebcamPositionPreset } from "../vendor/recordly/types";
import {
  getCropMatchedWebcamHeightPercent,
  getWebcamCornerRadiusPx,
  getWebcamCropSourceRect,
  getWebcamOverlayDimensionsPx,
  getWebcamOverlayPosition,
  getWebcamPositionForPreset,
  scaleWebcamOverlayPixels,
} from "../vendor/recordly/webcamOverlay";
import { getWebcamShadowFilter } from "../vendor/recordly/shadowProfile";
import { drawSquircleOnCanvas } from "../vendor/recordly/squircle";

type Ctx2D = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

/** Bubble size, % of the output's shorter side. Change this one number to resize the default bubble. */
export const WEBCAM_SIZE_PERCENT = 40;

export interface WebcamStyle {
  enabled: boolean; sizePercent: number; roundness: number; shadow: number; margin: number;
  positionPreset: WebcamPositionPreset; positionX: number; positionY: number; mirror: boolean;
  reactToZoom: boolean; cropRegion: CropRegion;
}

const DEFAULT_PRESET: WebcamPositionPreset = "bottom-right";
const presetPos = getWebcamPositionForPreset(DEFAULT_PRESET);

export const WEBCAM_DEFAULTS: WebcamStyle = {
  enabled: true, // Recordly: false (no webcam until one is recorded); glide only calls this when a cam track exists
  sizePercent: WEBCAM_SIZE_PERCENT,
  roundness: 100,
  shadow: 0.3,
  margin: 24,
  positionPreset: DEFAULT_PRESET,
  positionX: presetPos.x,
  positionY: presetPos.y,
  mirror: true,
  reactToZoom: true,
  cropRegion: { x: 0, y: 0, width: 1, height: 1 },
};

let bubbleCanvas: OffscreenCanvas | HTMLCanvasElement | null = null;
let bubbleCtx: Ctx2D | null = null;

function getBubble(w: number, h: number): { canvas: OffscreenCanvas | HTMLCanvasElement; ctx: Ctx2D } | null {
  if (!bubbleCanvas) {
    if (typeof OffscreenCanvas !== "undefined") bubbleCanvas = new OffscreenCanvas(w, h);
    else if (typeof document !== "undefined") bubbleCanvas = document.createElement("canvas");
    else return null;
    bubbleCtx = bubbleCanvas.getContext("2d") as Ctx2D | null;
  }
  if (!bubbleCtx) return null;
  if (bubbleCanvas.width !== w || bubbleCanvas.height !== h) { bubbleCanvas.width = w; bubbleCanvas.height = h; }
  return { canvas: bubbleCanvas, ctx: bubbleCtx };
}

/** Pure geometry, same math as frameRenderer. Exposed for tests and the editor preview. */
export function computeWebcamBubbleLayout(W: number, H: number, srcW: number, srcH: number, s: WebcamStyle, zoomScale: number) {
  const sourceWidth = srcW || 1;
  const sourceHeight = srcH || sourceWidth;
  const margin = scaleWebcamOverlayPixels(s.margin ?? 24, W);
  const widthPercent = s.sizePercent;
  const heightPercent = getCropMatchedWebcamHeightPercent(widthPercent, s.sizePercent, sourceWidth, sourceHeight, s.cropRegion);
  const dimensions = getWebcamOverlayDimensionsPx({
    containerWidth: W, containerHeight: H, widthPercent, heightPercent, margin,
    zoomScale: zoomScale || 1, reactToZoom: s.reactToZoom ?? true,
  });
  const { x, y } = getWebcamOverlayPosition({
    containerWidth: W, containerHeight: H, width: dimensions.width, height: dimensions.height, margin,
    positionPreset: s.positionPreset, positionX: s.positionX ?? 1, positionY: s.positionY ?? 1,
    legacyCorner: "bottom-right",
  });
  const radius = getWebcamCornerRadiusPx(s.roundness ?? 100, dimensions.width, dimensions.height);
  return { x, y, width: dimensions.width, height: dimensions.height, radius, sourceWidth, sourceHeight };
}

export function drawWebcamBubble(ctx: Ctx2D, W: number, H: number, frame: CanvasImageSource | null,
  srcW: number, srcH: number, s: WebcamStyle, zoomScale: number): void {
  if (!frame || !s.enabled) return;
  const L = computeWebcamBubbleLayout(W, H, srcW, srcH, s, zoomScale);
  const bubble = getBubble(Math.max(1, Math.ceil(L.width)), Math.max(1, Math.ceil(L.height)));
  if (!bubble) return;
  const bctx = bubble.ctx;
  bctx.clearRect(0, 0, bubble.canvas.width, bubble.canvas.height);
  bctx.imageSmoothingEnabled = true;
  bctx.imageSmoothingQuality = "high";
  const { sx, sy, sw, sh } = getWebcamCropSourceRect(s.cropRegion, L.sourceWidth, L.sourceHeight);
  const coverScale = Math.max(L.width / sw, L.height / sh);
  const drawWidth = sw * coverScale;
  const drawHeight = sh * coverScale;
  const drawX = (L.width - drawWidth) / 2;
  const drawY = (L.height - drawHeight) / 2;

  bctx.save();
  drawSquircleOnCanvas(bctx, { x: 0, y: 0, width: L.width, height: L.height, radius: L.radius });
  bctx.clip();
  if (s.mirror) {
    bctx.save();
    bctx.translate(L.width, 0);
    bctx.scale(-1, 1);
    bctx.drawImage(frame, sx, sy, sw, sh, drawX, drawY, drawWidth, drawHeight);
    bctx.restore();
  } else {
    bctx.drawImage(frame, sx, sy, sw, sh, drawX, drawY, drawWidth, drawHeight);
  }
  bctx.restore();

  if ((s.shadow ?? 0) > 0) {
    const shadowSize = Math.min(L.width, L.height);
    ctx.save();
    ctx.filter = getWebcamShadowFilter(shadowSize, s.shadow);
    ctx.drawImage(bubble.canvas, L.x, L.y, L.width, L.height);
    ctx.restore();
    return;
  }
  ctx.drawImage(bubble.canvas, L.x, L.y, L.width, L.height);
}
