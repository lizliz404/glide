// Glide-side checks for P2 (frame.ts + render.ts) against Recordly's defaults.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { computeFrameLayout, FRAME_DEFAULTS, WALLPAPERS, backgroundToWallpaper } from "../../src/editor/frame";
import { renderFrame, type Ctx2D, type RenderFrameInput } from "../../src/editor/render";
import { getSceneEffectMetrics } from "../../src/vendor/recordly/sceneEffects";
import { existsSync } from "node:fs";

describe("FRAME_DEFAULTS / WALLPAPERS", () => {
	it("match Recordly's project defaults (radius uses the macOS value)", () => {
		expect(FRAME_DEFAULTS).toEqual({
			background: { kind: "image", url: "wallpapers/tahoe-light.jpg" },
			padding: 20,
			borderRadius: 8,
			shadowIntensity: 0.67,
			backgroundBlur: 0,
		});
	});

	it("ships the five picked wallpapers as real files, default first", () => {
		expect(WALLPAPERS.map((w) => w.id)).toEqual(["tahoe-light", "tahoe-dark", "sequoia-blue-orange", "ventura", "glassmorphism-4"]);
		for (const w of WALLPAPERS) expect(existsSync(`static/${w.url}`)).toBe(true);
		expect(backgroundToWallpaper(FRAME_DEFAULTS.background)).toBe(WALLPAPERS[0].url);
	});
});

describe("computeFrameLayout", () => {
	it("insets the mask 4% per side at 1920x1080 and uses 8% of the mask's short side as radius", () => {
		const { mask, radiusPx, sprite } = computeFrameLayout(1920, 1080, 1920, 1080, FRAME_DEFAULTS);
		expect(mask.x).toBeCloseTo(1920 * 0.04);
		expect(mask.y).toBeCloseTo(1080 * 0.04);
		expect(mask.width).toBeCloseTo(1920 * 0.92);
		expect(mask.height).toBeCloseTo(1080 * 0.92);
		expect(radiusPx).toBeCloseTo(Math.min(mask.width, mask.height) * 0.08);
		expect(sprite).toEqual(mask);
	});

	it("letterboxes a narrower source inside the padded area", () => {
		const { mask } = computeFrameLayout(1920, 1080, 1080, 1080, FRAME_DEFAULTS);
		expect(mask.height).toBeCloseTo(1080 * 0.92);
		expect(mask.width).toBeCloseTo(1080 * 0.92);
		expect(mask.x + mask.width / 2).toBeCloseTo(960);
	});
});

// ---- renderFrame call-order check with a recording fake 2D context -----------------------------

type Call = [string, ...unknown[]];
function fakeCtx(log: Call[], tag: string) {
	const state = { filter: "none" };
	return new Proxy(
		{},
		{
			get(_t, k: string) {
				if (k === "filter") return state.filter;
				if (k === "canvas") return undefined;
				return (...a: unknown[]) => {
					log.push([`${tag}.${k}`, ...a]);
					if (k === "createLinearGradient" || k === "createRadialGradient")
						return { addColorStop: (...s: unknown[]) => log.push([`${tag}.addColorStop`, ...s]) };
				};
			},
			set(_t, k: string, v) {
				if (k === "filter") state.filter = v;
				log.push([`${tag}.=${k}`, v]);
				return true;
			},
		},
	) as unknown as Ctx2D;
}

const g = globalThis as Record<string, unknown>;
const saved = { Off: g.OffscreenCanvas, Path: g.Path2D };
const log: Call[] = [];
let n = 0;
beforeAll(() => {
	g.OffscreenCanvas = class {
		width: number;
		height: number;
		tag = `scratch${n++}`;
		constructor(w: number, h: number) {
			this.width = w;
			this.height = h;
		}
		getContext() {
			return fakeCtx(log, this.tag);
		}
	};
	g.Path2D = class {
		moveTo() {}
		lineTo() {}
		closePath() {}
		rect() {}
	};
});
afterAll(() => {
	g.OffscreenCanvas = saved.Off;
	g.Path2D = saved.Path;
});

describe("renderFrame (Recordly compositeWithShadows order)", () => {
	it("draws background, camera-transformed layer with cursor inside, shadowed composite, webcam last", () => {
		const ctx = fakeCtx(log, "main");
		const screen = { width: 1920, height: 1080 } as unknown as CanvasImageSource;
		const hooks: string[] = [];
		renderFrame(ctx, 1920, 1080, {
			screen,
			videoW: 1920,
			videoH: 1080,
			bgImage: null,
			style: { ...FRAME_DEFAULTS, background: { kind: "color", color: "#123456" } },
			camera: { scale: 1.8, x: -100, y: -50, zoomScale: 1.8 },
			drawCursor: (c, vp) => {
				hooks.push("cursor");
				expect(vp.x).toBeCloseTo(76.8);
				// The layer context still carries the camera transform.
				const lastTransform = log.filter((l) => l[0].endsWith(".setTransform")).at(-1)!;
				expect(lastTransform.slice(1)).toEqual([1.8, 0, 0, 1.8, -100, -50]);
				expect(c).not.toBe(ctx);
			},
			drawWebcam: (c, W, H, z) => {
				hooks.push("webcam");
				expect(c).toBe(ctx);
				expect([W, H, z]).toEqual([1920, 1080, 1.8]);
			},
		});
		expect(hooks).toEqual(["cursor", "webcam"]);
		const main = log.filter((l) => l[0].startsWith("main."));
		const draws = main.filter((l) => l[0] === "main.drawImage");
		expect(draws).toHaveLength(2); // background canvas, then the video layer
		const filterSet = main.find((l) => l[0] === "main.=filter")!;
		expect(String(filterSet[1])).toMatch(/^drop-shadow\(.*drop-shadow\(.*drop-shadow\(/);
		// Background colour was painted on the scratch background canvas.
		expect(log.some((l) => l[0].endsWith(".=fillStyle") && l[1] === "#123456")).toBe(true);
		// Screen drawn into the mask on the layer.
		const layerDraw = log.find((l) => l[0].startsWith("scratch") && l[0].endsWith(".drawImage") && l[1] === screen)!;
		expect(layerDraw.slice(2).map((v) => Math.round(v as number))).toEqual([77, 43, 1766, 994]);
	});

	it("skips the shadow filter when intensity is 0", () => {
		log.length = 0;
		const ctx = fakeCtx(log, "main2");
		renderFrame(ctx, 640, 360, {
			screen: null,
			videoW: 0,
			videoH: 0,
			bgImage: null,
			style: { ...FRAME_DEFAULTS, shadowIntensity: 0, background: { kind: "gradient", css: "linear-gradient(180deg, #000, #fff)" } },
			camera: { scale: 1, x: 0, y: 0, zoomScale: 1 },
		});
		expect(log.some((l) => l[0] === "main2.=filter" && String(l[1]).includes("drop-shadow"))).toBe(false);
		// Recordly's gradient parser: "180deg" is skipped, colours spread by part index.
		expect(log.filter((l) => l[0].endsWith(".addColorStop")).map((l) => l.slice(1))).toEqual([[0.5, "#000"], [1, "#fff"]]);
	});
});

describe("static blurred background cache", () => {
	const blurCalls = () => log.filter((l) => l[0].endsWith(".=filter") && String(l[1]).startsWith("blur("));
	const input = (): RenderFrameInput => ({
		screen: { width: 640, height: 360 } as unknown as CanvasImageSource,
		videoW: 640, videoH: 360, bgImage: null,
		style: { ...FRAME_DEFAULTS, background: { kind: "color", color: "#123456" }, backgroundBlur: 10 },
		camera: { scale: 1, x: 0, y: 0, zoomScale: 1 },
	});

	it("reuses the final overscanned blur while video, cursor, shadows and webcam keep drawing", () => {
		log.length = 0;
		const ctx = fakeCtx(log, "cached");
		const inp = input();
		let cursors = 0;
		let webcams = 0;
		inp.drawCursor = () => { cursors++; };
		inp.drawWebcam = () => { webcams++; };
		renderFrame(ctx, 640, 360, inp);
		const firstScreen = inp.screen;
		inp.screen = { width: 640, height: 360 } as unknown as CanvasImageSource;
		inp.camera = { scale: 1.8, x: -100, y: -50, zoomScale: 1.8 };
		inp.style = { ...inp.style, shadowIntensity: 0.4 };
		renderFrame(ctx, 640, 360, inp);

		expect(blurCalls()).toHaveLength(1);
		const blurTag = blurCalls()[0][0].replace(".=filter", "");
		const effects = getSceneEffectMetrics({ viewportWidth: 640, backgroundBlur: 10, shadowIntensity: 0 });
		expect(blurCalls()[0][1]).toBe(`blur(${effects.backgroundBlurPx}px)`);
		const overscan = effects.backgroundOverscanPx;
		expect(log.find((l) => l[0] === `${blurTag}.drawImage`)!.slice(2)).toEqual([-overscan, -overscan, 640 + 2 * overscan, 360 + 2 * overscan]);
		const backgrounds = log.filter((l) => l[0] === "cached.drawImage").filter((_, i) => i % 2 === 0);
		expect(backgrounds).toHaveLength(2);
		expect(backgrounds[0][1]).toBe(backgrounds[1][1]);
		expect(backgrounds[0].slice(2)).toEqual([0, 0, 640, 360]);
		expect(log.filter((l) => l[0].endsWith(".drawImage") && (l[1] === firstScreen || l[1] === inp.screen))).toHaveLength(2);
		expect(log.filter((l) => l[0] === "cached.=filter" && String(l[1]).startsWith("drop-shadow("))).toHaveLength(2);
		expect([cursors, webcams]).toEqual([2, 2]);
	});

	it("invalidates on blur, background value/kind, image identity/source dimensions and output dimensions", () => {
		log.length = 0;
		const ctx = fakeCtx(log, "invalidated");
		const inp = input();
		let w = 640;
		let h = 360;
		let expectedBlurs = 0;
		const rebuild = () => {
			renderFrame(ctx, w, h, inp);
			expect(blurCalls()).toHaveLength(++expectedBlurs);
			renderFrame(ctx, w, h, inp);
			expect(blurCalls()).toHaveLength(expectedBlurs);
		};
		rebuild();
		inp.style.backgroundBlur = 20;
		rebuild();
		inp.style.background = { kind: "color", color: "#abcdef" };
		rebuild();
		// Equal value but a different kind must also invalidate.
		inp.style.background = { kind: "gradient", css: "#abcdef" };
		rebuild();
		inp.style.background = { kind: "image", url: "wallpapers/tahoe-light.jpg" };
		rebuild(); // missing image uses the existing black fallback
		const image = { width: 640, height: 360 };
		inp.bgImage = image as unknown as CanvasImageSource;
		rebuild();
		inp.bgImage = { ...image } as unknown as CanvasImageSource;
		rebuild();
		image.width = 800;
		inp.bgImage = image as unknown as CanvasImageSource;
		rebuild();
		image.height = 600; // same source object, new dimensions
		rebuild();
		inp.style.background = { kind: "image", url: "wallpapers/tahoe-dark.jpg" };
		rebuild();
		w = 800;
		rebuild();
		h = 600;
		rebuild();
	});

	it("bypasses blur at zero, reuses it when restored, and isolates destination contexts", () => {
		log.length = 0;
		const ctx = fakeCtx(log, "toggle");
		const inp = input();
		inp.style.backgroundBlur = 0;
		renderFrame(ctx, 640, 360, inp);
		expect(blurCalls()).toHaveLength(0);
		const rawBackground = log.find((l) => l[0] === "toggle.drawImage")![1];
		inp.style.backgroundBlur = 10;
		renderFrame(ctx, 640, 360, inp);
		inp.style.backgroundBlur = 0;
		renderFrame(ctx, 640, 360, inp);
		expect(log.filter((l) => l[0] === "toggle.drawImage").at(-2)![1]).toBe(rawBackground);
		inp.style.backgroundBlur = 10;
		renderFrame(ctx, 640, 360, inp);
		expect(blurCalls()).toHaveLength(1);
		renderFrame(fakeCtx(log, "other"), 640, 360, inp);
		expect(blurCalls()).toHaveLength(2);
	});
});
