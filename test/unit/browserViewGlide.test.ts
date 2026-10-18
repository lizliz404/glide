import { describe, expect, it } from "vitest";
import { browserCrop, normalizeBrowserView, projectSceneForCrop, type BrowserView } from "../../src/editor/browserView";
import { computeFrameLayout, FRAME_DEFAULTS } from "../../src/editor/frame";
import type { CursorTelemetryPoint, ZoomRegion } from "../../src/vendor/recordly/types";

const view = (patch: Partial<BrowserView> = {}): BrowserView => ({ hideTop: true, topPx: 100, ...patch });

describe("normalizeBrowserView", () => {
	it("defaults to hidden-off and 100px, and keeps only bounded numbers", () => {
		expect(normalizeBrowserView(undefined)).toEqual({ hideTop: false, topPx: 100 });
		expect(normalizeBrowserView({ hideTop: true, topPx: 80 })).toEqual({ hideTop: true, topPx: 80 });
		expect(normalizeBrowserView({ hideTop: "yes", topPx: Number.NaN })).toEqual({ hideTop: false, topPx: 100 });
		expect(normalizeBrowserView({ topPx: -20 }).topPx).toBe(0);
		expect(normalizeBrowserView({ topPx: 1e9 }).topPx).toBe(100_000);
	});
});

describe("browserCrop", () => {
	it("returns the full frame unless a positive top strip fits in the source", () => {
		expect(browserCrop(view({ hideTop: false }), 1080)).toEqual({ x: 0, y: 0, width: 1, height: 1 });
		expect(browserCrop(view({ topPx: 0 }), 1080)).toEqual({ x: 0, y: 0, width: 1, height: 1 });
		expect(browserCrop(view(), 0)).toEqual({ x: 0, y: 0, width: 1, height: 1 });
		expect(browserCrop(view({ topPx: 1080 }), 1080)).toEqual({ x: 0, y: 0, width: 1, height: 1 });
		expect(browserCrop(view({ topPx: 108 }), 1080)).toEqual({ x: 0, y: 0.1, width: 1, height: 0.9 });
	});

	it("preserves cropped aspect and shifts the source sprite relative to its mask", () => {
		const full = computeFrameLayout(1920, 1080, 1920, 1080, FRAME_DEFAULTS);
		const cropped = computeFrameLayout(1920, 1080, 1920, 1080, FRAME_DEFAULTS, browserCrop(view({ topPx: 108 }), 1080));
		expect(cropped.mask.width).toBeCloseTo(full.mask.width);
		expect(cropped.mask.height).toBeCloseTo(full.mask.height * 0.9);
		expect(cropped.sprite.y).toBeCloseTo(cropped.mask.y - 0.1 * cropped.sprite.height);
		expect(cropped.sprite.height).toBeCloseTo(full.sprite.height);
	});
});

describe("projectSceneForCrop", () => {
	const telemetry: CursorTelemetryPoint[] = [
		{ timeMs: 0, cx: 0.2, cy: 0.05 },
		{ timeMs: 16, cx: 0.4, cy: 0.2, interactionType: "click" },
	];
	const regions: ZoomRegion[] = [
		{ id: "a", startMs: 0, endMs: 500, depth: 3, focus: { cx: 0.5, cy: 0.05 }, mode: "manual" },
		{ id: "b", startMs: 500, endMs: 900, depth: 2, focus: { cx: 0.1, cy: 0.5 }, mode: "auto" },
	];

	it("drops off-crop pointers and clamps region focus without mutating the originals", () => {
		const crop = browserCrop(view({ topPx: 108 }), 1080);
		const projected = projectSceneForCrop(telemetry, regions, crop);
		expect(projected.telemetry).toEqual([{ ...telemetry[1], cy: (0.2 - 0.1) / 0.9 }]);
		expect(projected.regions.map((region) => region.focus)).toEqual([
			{ cx: 0.5, cy: 0 },
			{ cx: 0.1, cy: (0.5 - 0.1) / 0.9 },
		]);
		expect(projected.regions[0]).not.toBe(regions[0]);
		expect(telemetry[0]).toEqual({ timeMs: 0, cx: 0.2, cy: 0.05 });
		expect(regions[0].focus).toEqual({ cx: 0.5, cy: 0.05 });
		expect(regions[1].mode).toBe("auto");
	});

	it("projects visible pointers into cropped coordinates exactly once", () => {
		const source = [{ timeMs: 10, cx: 0.4, cy: 0.6 }];
		const result = projectSceneForCrop(source, [], { x: 0, y: 0.2, width: 1, height: 0.8 });
		expect(result.telemetry[0].cy).toBeCloseTo(0.5);
		expect(source[0].cy).toBe(0.6);
	});
	it("keeps a full crop as a shallow copy of the original coordinates", () => {
		const projected = projectSceneForCrop(telemetry, regions, { x: 0, y: 0, width: 1, height: 1 });
		expect(projected.telemetry).toEqual(telemetry);
		expect(projected.regions[0].focus).toEqual(regions[0].focus);
		expect(projected.telemetry).not.toBe(telemetry);
	});
});
