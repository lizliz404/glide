// Copied from webadderallorg/Recordly (AGPL-3.0) @ e4a9d04860f4cbad3358bda3ac4a2307489f1d03
// Source: src/lib/exporter/shadowProfile.test.ts
// Changes: import path -> ../../src/vendor/recordly/

import { describe, expect, it } from "vitest";
import {
	getWebcamShadowFilter,
	getWebcamShadowStrength,
	WEBCAM_SHADOW_LAYER_PROFILES,
} from "../../src/vendor/recordly/shadowProfile";

describe("getWebcamShadowStrength", () => {
	it("doubles the webcam shadow response and clamps it", () => {
		expect(getWebcamShadowStrength(0)).toBe(0);
		expect(getWebcamShadowStrength(0.25)).toBe(0.5);
		expect(getWebcamShadowStrength(0.5)).toBe(1);
		expect(getWebcamShadowStrength(1)).toBe(1);
	});

	it("adds a tighter contact shadow so strength also increases density", () => {
		expect(WEBCAM_SHADOW_LAYER_PROFILES).toHaveLength(2);
		expect(getWebcamShadowFilter(100, 0)).toBe("none");
		const filter = getWebcamShadowFilter(100, 0.5);
		expect(filter.match(/drop-shadow/g)).toHaveLength(2);
		expect(filter).toContain("rgba(0, 0, 0, 0.9)");
		expect(filter).toContain("rgba(0, 0, 0, 0.8)");
	});
});
