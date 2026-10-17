// Compositor shared by live preview and export, so what you see is what you export.
import { easeOutCubic } from "../vendor/openscreen/mathUtils";
import type { CameraFrame, Track } from "./camera";
import type { Settings } from "./settings";

type Src = CanvasImageSource & { videoWidth?: number; videoHeight?: number; width?: number | SVGAnimatedLength; height?: number | SVGAnimatedLength };
type Ctx = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

const dims = (s: Src): [number, number] => {
	if (typeof s.videoWidth === "number" && s.videoWidth) return [s.videoWidth, s.videoHeight ?? 0];
	return [Number(s.width) || 0, Number(s.height) || 0];
};

export interface RenderInput {
	screen: Src | null;
	camera: Src | null;
	bgImage: CanvasImageSource | null;
	cam: CameraFrame;
	track: Track;
	t: number;
	settings: Settings;
}

function roundRect(ctx: Ctx, x: number, y: number, w: number, h: number, r: number) {
	ctx.beginPath();
	ctx.roundRect(x, y, w, h, r);
}

function drawBackground(ctx: Ctx, W: number, H: number, s: Settings, img: CanvasImageSource | null) {
	const bg = s.background;
	if (bg.kind === "image" && img) {
		const [iw, ih] = dims(img as Src);
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

function drawCursor(ctx: Ctx, x: number, y: number, k: number, style: string, pressed: boolean) {
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
		// macOS-like arrow; "pointer" gets a small dot to read as clickable.
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

export function renderFrame(ctx: Ctx, W: number, H: number, inp: RenderInput) {
	const { settings: s, cam } = inp;
	const unit = Math.min(W, H) / 1080;
	ctx.save();
	ctx.clearRect(0, 0, W, H);
	drawBackground(ctx, W, H, s, inp.bgImage);

	// Display rect: source aspect, contained inside the padded area.
	const pad = Math.min(W, H) * s.padding;
	const [sw, sh] = inp.screen ? dims(inp.screen) : [16, 9];
	const availW = W - pad * 2;
	const availH = H - pad * 2;
	const k = Math.min(availW / sw, availH / sh);
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
		roundRect(ctx, dx, dy, dw, dh, r);
		ctx.fillStyle = "#000";
		ctx.fill();
		ctx.restore();
	}

	ctx.save();
	roundRect(ctx, dx, dy, dw, dh, r);
	ctx.clip();
	if (inp.screen && sw && sh) {
		const v = cam.view;
		ctx.imageSmoothingQuality = "high";
		ctx.drawImage(inp.screen, v.x * sw, v.y * sh, v.w * sw, v.h * sh, dx, dy, dw, dh);
	} else {
		ctx.fillStyle = "#000";
		ctx.fillRect(dx, dy, dw, dh);
	}

	// Cursor + click ripples, mapped through the zoom window.
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
		drawCursor(ctx, x, y, 1.6 * unit * s.cursor.size * cam.scale ** 0.35, cam.cursor.style, cam.cursor.pressed);
	}
	ctx.restore();

	// Webcam bubble.
	if (s.webcam.show && inp.camera) {
		const [cw, ch] = dims(inp.camera);
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
			roundRect(ctx, bx, by, size, size, br);
			ctx.fillStyle = "#111";
			ctx.fill();
			ctx.restore();
			ctx.save();
			roundRect(ctx, bx, by, size, size, br);
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
			roundRect(ctx, bx, by, size, size, br);
			ctx.lineWidth = 4 * unit;
			ctx.strokeStyle = "rgba(255,255,255,0.9)";
			ctx.stroke();
		}
	}
	ctx.restore();
}
