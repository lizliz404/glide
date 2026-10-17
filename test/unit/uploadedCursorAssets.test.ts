// Ported from webadderallorg/Recordly (AGPL-3.0) @ e4a9d04860f4cbad3358bda3ac4a2307489f1d03
// Source: src/components/video-editor/videoPlayback/uploadedCursorAssets.test.ts
// Changes: import paths only

import { describe, expect, it } from "vitest";
import { cursorSetAssets, getCursorStyleSizeMultiplier } from "../../src/vendor/recordly/uploadedCursorAssets";

describe("Windows system cursor assets", () => {
	it("uses the native 32px cursor hotspots", () => {
		expect(cursorSetAssets.windows11.arrow.fallbackAnchor).toEqual({ x: 0, y: 0 });
		expect(cursorSetAssets.windows11.pointer.fallbackAnchor).toEqual({ x: 6 / 32, y: 0 });
		expect(cursorSetAssets.windows11["resize-ew"].fallbackAnchor).toEqual({
			x: 11 / 32,
			y: 4 / 32,
		});
		expect(cursorSetAssets.windows11["resize-ns"].fallbackAnchor).toEqual({
			x: 4 / 32,
			y: 11 / 32,
		});
		expect(cursorSetAssets.windows11["not-allowed"].fallbackAnchor).toEqual({
			x: 8 / 32,
			y: 8 / 32,
		});
	});

	it("normalizes the Windows cursor set from the measured arrow pixel height", () => {
		expect(getCursorStyleSizeMultiplier("windows11")).toBeCloseTo(32 / 19.0625, 8);
	});
});
