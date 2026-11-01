import { describe, expect, it } from "vitest";
import { idleAlpha, SMOOTHING_PRESETS, smoothingPresetOf } from "../../src/editor/cursor";

describe("cursor presets + idle hide", () => {
	it("maps smoothing values back to Cap presets", () => {
		expect(smoothingPresetOf({ smoothing: SMOOTHING_PRESETS.fast.smoothing })).toBe("fast");
		expect(smoothingPresetOf({ smoothing: 0.123 })).toBe("");
	});
	it("fades out after the cursor rests", () => {
		const t = [{ timeMs: 0, cx: 0.1, cy: 0.1 }, { timeMs: 100, cx: 0.5, cy: 0.5 }, { timeMs: 5000, cx: 0.5, cy: 0.5 }] as never;
		expect(idleAlpha(t, 500, 2000)).toBe(1);
		expect(idleAlpha(t, 2250, 2000)).toBeCloseTo(0.5, 1);
		expect(idleAlpha(t, 4000, 2000)).toBe(0);
	});
});
