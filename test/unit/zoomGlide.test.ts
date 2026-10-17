// Glide-side checks for the P1 port: PointerEvt -> toTelemetry -> suggestZoomRegions -> SceneCamera.
import { describe, expect, it } from "vitest";
import type { PointerEvt } from "../../src/shared/types";
import { SceneCamera, suggestZoomRegions, ZOOM_DEFAULTS } from "../../src/editor/camera";
import { toTelemetry } from "../../src/editor/telemetry";
import { ZOOM_DEPTH_SCALES } from "../../src/vendor/recordly/types";
import { computeZoomTransform } from "../../src/vendor/recordly/zoomTransformMath";

function evt(t: number, kind: PointerEvt["kind"], x: number, y: number, cursor: PointerEvt["cursor"] = "arrow"): PointerEvt {
	return { t, kind, tab: [x, y], win: [x * 0.9, y * 0.9], mon: [x * 0.5, y * 0.5], cursor };
}

/** Moves every 50 ms toward each click, then down + up 80 ms apart. */
function scenario(): PointerEvt[] {
	const events: PointerEvt[] = [];
	const clicks: Array<[number, number, number]> = [
		[2000, 0.3, 0.4],
		[3000, 0.32, 0.42],
		[4000, 0.34, 0.44],
		[9000, 0.7, 0.6],
	];
	let prev: [number, number, number] = [0, 0.5, 0.5];
	for (const c of clicks) {
		for (let t = prev[0] + 50; t < c[0]; t += 50) {
			const k = (t - prev[0]) / (c[0] - prev[0]);
			events.push(evt(t, "move", prev[1] + (c[1] - prev[1]) * k, prev[2] + (c[2] - prev[2]) * k));
		}
		events.push(evt(c[0], "down", c[1], c[2], "pointer"));
		events.push(evt(c[0] + 80, "up", c[1], c[2], "pointer"));
		prev = [c[0] + 80, c[1], c[2]];
	}
	return events;
}

const TOTAL_MS = 15000;
const STAGE = { width: 1920, height: 1080 };
const MASK = { x: 76.8, y: 43.2, width: 1766.4, height: 993.6 };

describe("toTelemetry", () => {
	it("maps kinds, surface coordinates and cursor types to Recordly telemetry", () => {
		const t = toTelemetry(
			[
				evt(100, "move", 0.1, 0.1),
				evt(200, "down", 0.2, 0.2, "pointer"),
				evt(260, "up", 0.2, 0.2, "pointer"),
				evt(400, "down", 0.21, 0.2, "pointer"), // 200 ms later, 0.01 away -> double-click
				evt(800, "down", 0.21, 0.2, "pointer"), // 400 ms later -> plain click
				evt(900, "rightclick", 0.5, 0.5, "open-hand"),
				evt(1000, "middleclick", 0.6, 0.6, "resize-ew"),
			],
			"window",
			5000,
		);
		expect(t.map((p) => p.interactionType)).toEqual([
			"move",
			"click",
			"mouseup",
			"double-click",
			"click",
			"right-click",
			"middle-click",
		]);
		expect(t[0]).toMatchObject({ timeMs: 100, cx: 0.1 * 0.9, cy: 0.1 * 0.9, cursorType: "arrow" });
		expect(t[5].cursorType).toBe("open-hand");
		expect(t[6].cursorType).toBe("resize-ew");
	});

	it("clamps like normalizeCursorTelemetry and sorts by time", () => {
		const t = toTelemetry([evt(900, "move", 1.4, -0.2), evt(20000, "move", 0.5, 0.5)], "browser", 10000);
		expect(t[0]).toMatchObject({ timeMs: 900, cx: 1, cy: 0 });
		expect(t[1].timeMs).toBe(10000);
	});
});

describe("suggestZoomRegions", () => {
	it("turns 3 clicks 1 s apart + 1 click 5 s later into 2 auto regions with 500 ms padding at depth 3", () => {
		const telemetry = toTelemetry(scenario(), "browser", TOTAL_MS);
		const regions = suggestZoomRegions(telemetry, TOTAL_MS, 16 / 9);
		expect(regions).toHaveLength(2);
		expect(regions[0]).toMatchObject({ id: "auto-1", startMs: 1500, endMs: 4500, depth: 3, mode: "auto" });
		expect(regions[1]).toMatchObject({ id: "auto-2", startMs: 8500, endMs: 9500, depth: 3, mode: "auto" });
		expect(regions[1].focus).toEqual({ cx: 0.7, cy: 0.6 });
	});

	it("is suppressed for portrait / near-square sources, like useFreshRecordingAutoZoom", () => {
		const telemetry = toTelemetry(scenario(), "browser", TOTAL_MS);
		expect(suggestZoomRegions(telemetry, TOTAL_MS, 1.1)).toEqual([]);
		expect(suggestZoomRegions(telemetry, TOTAL_MS, 1.2)).toHaveLength(2);
	});

	it("uses the Focused preset defaults", () => {
		expect(ZOOM_DEFAULTS).toEqual({
			connectZooms: true,
			zoomInDurationMs: 200,
			zoomOutDurationMs: 200,
			zoomSmoothness: 0.5,
			cameraSpring: { stiffnessMultiplier: 1, dampingMultiplier: 1.13, massMultiplier: 1.12 },
			classicMode: false,
			autoZoomDepth: 3,
		});
	});
});

describe("SceneCamera", () => {
	const telemetry = toTelemetry(scenario(), "browser", TOTAL_MS);
	const regions = suggestZoomRegions(telemetry, TOTAL_MS, 16 / 9);

	function run(untilMs: number, fps = 60) {
		const cam = new SceneCamera(ZOOM_DEFAULTS);
		const samples = new Map<number, ReturnType<SceneCamera["step"]>>();
		for (let f = 0; f * (1000 / fps) <= untilMs; f += 1) {
			const t = f * (1000 / fps);
			samples.set(Math.round(t), cam.step(t, STAGE, MASK, telemetry, regions));
		}
		return { cam, samples };
	}

	it("converges to 1.8x mid-region and back to 1x after it", () => {
		const { samples } = run(8000);
		const at = (ms: number) => {
			let best: ReturnType<SceneCamera["step"]> | undefined;
			for (const [t, v] of samples) if (t <= ms) best = v;
			return best!;
		};
		expect(at(0).scale).toBe(1);
		const mid = at(3500);
		expect(mid.scale).toBeCloseTo(ZOOM_DEPTH_SCALES[3], 3);
		expect(mid.progress).toBe(1);
		expect(mid.zoomScale).toBeCloseTo(1.8, 3);
		const after = at(7000);
		expect(after.scale).toBeCloseTo(1, 3);
		expect(after.x).toBeCloseTo(0, 1);
		expect(after.y).toBeCloseTo(0, 1);
		expect(after.progress).toBe(0);
	});

	it("is frame-rate independent (content-time springs)", () => {
		const a = run(3500, 60).samples;
		const b = run(3500, 30).samples;
		const last = (m: Map<number, { scale: number }>) => [...m.values()].at(-1)!.scale;
		expect(last(a)).toBeCloseTo(last(b), 3);
	});

	it("snap jumps straight to computeZoomTransform's target and a repeated time keeps the frame", () => {
		const cam = new SceneCamera(ZOOM_DEFAULTS);
		cam.step(0, STAGE, MASK, telemetry, regions);
		const snapped = cam.step(3500, STAGE, MASK, telemetry, regions, true);
		const expected = computeZoomTransform({
			stageSize: STAGE,
			baseMask: MASK,
			zoomScale: 1.8,
			zoomProgress: 1,
			focusX: regions[0].focus.cx,
			focusY: regions[0].focus.cy,
		});
		expect(snapped.scale).toBeCloseTo(expected.scale, 6);
		expect(snapped.x).toBeCloseTo(expected.x, 6);
		expect(snapped.y).toBeCloseTo(expected.y, 6);
		expect(cam.step(3500, STAGE, MASK, telemetry, regions)).toBe(snapped);
		cam.reset();
		expect(cam.step(0, STAGE, MASK, telemetry, regions).scale).toBe(1);
	});

	it("classic mode follows the projected target without springs", () => {
		const cam = new SceneCamera({ ...ZOOM_DEFAULTS, classicMode: true });
		cam.step(0, STAGE, MASK, telemetry, regions);
		const s = cam.step(1700, STAGE, MASK, telemetry, regions);
		expect(s.scale).toBeCloseTo(1.8, 6);
	});
});
