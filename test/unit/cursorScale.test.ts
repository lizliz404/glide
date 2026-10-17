// Ported from webadderallorg/Recordly (AGPL-3.0) @ e4a9d04860f4cbad3358bda3ac4a2307489f1d03
// Source: src/components/video-editor/videoPlayback/cursorScale.test.ts
// Changes: import paths only

import { describe, expect, it } from "vitest";
import { getCursorViewportScale } from "../../src/vendor/recordly/cursorScale";

describe("cursor preview/export scale", () => {
	it("preserves the same cursor-to-video ratio at preview and export sizes", () => {
		const baseCursorHeight = 28 * 2.5;
		const previewWidth = 720;
		const exportWidth = 2940;
		const previewCursorHeight = baseCursorHeight * getCursorViewportScale(previewWidth);
		const exportCursorHeight = baseCursorHeight * getCursorViewportScale(exportWidth);

		expect(previewCursorHeight / previewWidth).toBeCloseTo(exportCursorHeight / exportWidth, 8);
	});
});
