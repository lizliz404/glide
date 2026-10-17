import { describe, expect, it, vi } from "vitest";
import { CURSOR_DEFAULTS, CursorLayer, toRenderConfig } from "../../src/editor/cursor";
import {
	CanvasCursorOverlay,
	DEFAULT_CURSOR_CONFIG,
	SmoothedCursorState,
	getCursorVisualState,
} from "../../src/vendor/recordly/cursorCanvas";
import type { CursorTelemetryPoint } from "../../src/vendor/recordly/types";

const FRAME_MS = 1000 / 60;

// Same formula as CanvasCursorOverlay.update / drawCursorOnCanvas (Recordly cursorRenderer L1405).
const bounceScale = (progress: number, clickBounce: number) =>
	Math.max(0.72, 1 - Math.sin(progress * Math.PI) * (0.08 * clickBounce));

function recordingCtx() {
	const calls: { op: string; args: unknown[] }[] = [];
	const ctx = new Proxy(
		{} as Record<string, unknown>,
		{
			get(target, prop: string) {
				if (prop in target) return target[prop];
				return (...args: unknown[]) => calls.push({ op: prop, args });
			},
			set(target, prop: string, value) {
				target[prop] = value;
				return true;
			},
		},
	);
	return { ctx: ctx as unknown as CanvasRenderingContext2D, calls };
}

describe("glide cursor defaults", () => {
	it("match Recordly's focused preset + E/types.ts defaults", () => {
		expect(CURSOR_DEFAULTS).toEqual({
			show: true,
			style: "tahoe",
			size: 2.5,
			smoothing: 0.67,
			spring: { stiffnessMultiplier: 1.35, dampingMultiplier: 0.79, massMultiplier: 1.29 },
			clickEffect: "none",
			clickEffectColor: "#2563EB",
			clickBounce: 2,
			clickBounceDuration: 350,
			sway: 0.4,
		});
	});

	it("builds the render config like frameRenderer (dotRadius = 28 x size)", () => {
		const cfg = toRenderConfig(CURSOR_DEFAULTS);
		expect(cfg.dotRadius).toBe(DEFAULT_CURSOR_CONFIG.dotRadius * 2.5);
		expect(cfg.dotRadius).toBe(70);
		expect(cfg.smoothingFactor).toBe(0.67);
		expect(cfg.springTuning).toEqual(CURSOR_DEFAULTS.spring);
		expect(cfg.clickEffectDurationMs).toBe(600);
	});
});

describe("glide cursor smoothing", () => {
	it("converges to the target within ~1 s of 60 fps steps", () => {
		const cfg = toRenderConfig(CURSOR_DEFAULTS);
		const state = new SmoothedCursorState({
			smoothingFactor: cfg.smoothingFactor!,
			springTuning: cfg.springTuning!,
			trailLength: 0,
		});
		state.update(0.1, 0.1, 0);
		let t = 0;
		let lagged = false;
		for (let i = 1; i <= 60; i += 1) {
			t = i * FRAME_MS;
			state.update(0.9, 0.7, t);
			if (i === 2 && Math.abs(state.x - 0.9) > 0.05) lagged = true;
		}
		expect(lagged).toBe(true); // it is smoothed, not snapped
		expect(state.x).toBeCloseTo(0.9, 2);
		expect(state.y).toBeCloseTo(0.7, 2);
	});
});

describe("glide click bounce", () => {
	it("stays at or above 0.72 during a click and dips below 1 mid-bounce", () => {
		const samples: CursorTelemetryPoint[] = [
			{ timeMs: 0, cx: 0.5, cy: 0.5, interactionType: "move" },
			{ timeMs: 1000, cx: 0.5, cy: 0.5, interactionType: "click" },
		];
		let min = Number.POSITIVE_INFINITY;
		for (let t = 1000; t <= 1000 + CURSOR_DEFAULTS.clickBounceDuration + 20; t += 5) {
			const { clickBounceProgress } = getCursorVisualState(
				samples,
				t,
				CURSOR_DEFAULTS.clickBounceDuration,
				600,
			);
			for (const strength of [CURSOR_DEFAULTS.clickBounce, 5]) {
				const s = bounceScale(clickBounceProgress, strength);
				expect(s).toBeGreaterThanOrEqual(0.72);
				if (strength === CURSOR_DEFAULTS.clickBounce) min = Math.min(min, s);
			}
		}
		expect(min).toBeLessThan(0.9); // 1 - 0.16 at the peak
		expect(min).toBeCloseTo(0.84, 2);
	});
});

describe("CanvasCursorOverlay", () => {
	it("draws the click effect at the click sample even when the cursor sprite is hidden", () => {
		const overlay = new CanvasCursorOverlay({
			...toRenderConfig({ ...CURSOR_DEFAULTS, clickEffect: "ripple" }),
		});
		const { ctx, calls } = recordingCtx();
		const samples: CursorTelemetryPoint[] = [
			{ timeMs: 0, cx: 0.25, cy: 0.5, interactionType: "click" },
			{ timeMs: 1000, cx: 0.75, cy: 0.5, interactionType: "move" },
		];
		// Effect starts after clickBounceDuration/2 = 175 ms.
		overlay.update(ctx, samples, 300, { x: 100, y: 50, width: 1000, height: 500 }, false);
		const arc = calls.find((c) => c.op === "arc");
		expect(arc).toBeDefined();
		expect(arc!.args[0]).toBeCloseTo(100 + 0.25 * 1000);
		expect(arc!.args[1]).toBeCloseTo(50 + 0.5 * 500);
		expect(calls.some((c) => c.op === "drawImage")).toBe(false);
	});

	it("draws nothing without telemetry and CursorLayer waits for assets", () => {
		const { ctx, calls } = recordingCtx();
		new CanvasCursorOverlay().update(ctx, [], 0, { x: 0, y: 0, width: 100, height: 100 }, true);
		expect(calls).toHaveLength(0);
		// Node has no fetch for relative URLs; the layer must not throw before preload resolves.
		vi.spyOn(console, "warn").mockImplementation(() => {});
		const layer = new CursorLayer(CURSOR_DEFAULTS);
		expect(() =>
			layer.draw(ctx, [{ timeMs: 0, cx: 0.5, cy: 0.5 }], 0, { x: 0, y: 0, width: 100, height: 100 }),
		).not.toThrow();
		expect(calls).toHaveLength(0);
	});
});
