import { describe, expect, it } from "vitest";
import { CURSOR_MOTION_PRESETS } from "../../src/vendor/recordly/cursorMotionPresets";
import { applyMotionPreset, defaultSettings, loadSettings, saveSettings } from "../../src/editor/settings";

describe("glide defaults = Recordly defaults", () => {
	it("composes the Focused preset and Recordly scene defaults", () => {
		const s = defaultSettings();
		expect(s.aspect).toBe("16:9");
		expect(s.motionPreset).toBe("focused");
		expect(s.zoom).toMatchObject({ connectZooms: true, zoomInDurationMs: 200, zoomOutDurationMs: 200, zoomSmoothness: 0.5, autoZoomDepth: 3 });
		expect(s.zoom.cameraSpring).toEqual({ stiffnessMultiplier: 1, dampingMultiplier: 1.13, massMultiplier: 1.12 });
		expect(s.frame).toMatchObject({ padding: 20, borderRadius: 8, shadowIntensity: 0.67, backgroundBlur: 0 });
		expect(s.frame.background).toEqual({ kind: "image", url: "wallpapers/tahoe-light.jpg" });
		expect(s.webcam).toMatchObject({ sizePercent: 40, roundness: 100, shadow: 0.3, margin: 24, positionPreset: "bottom-right", mirror: true, reactToZoom: true });
		expect(s.cursor).toMatchObject({ show: true, style: "tahoe", size: 2.5, smoothing: 0.67, clickEffect: "none", clickBounce: 2, clickBounceDuration: 350, sway: 0.4 });
	});

	it("applies the Smooth preset like SettingsPanel", () => {
		const s = defaultSettings();
		applyMotionPreset(s, "smooth");
		const p = CURSOR_MOTION_PRESETS.smooth;
		expect(s.zoom.zoomInDurationMs).toBe(p.zoomInDurationMs);
		expect(s.zoom.zoomOutDurationMs).toBe(p.zoomOutDurationMs);
		expect(s.cursor.spring).toEqual({ stiffnessMultiplier: p.cursorSpringStiffnessMultiplier, dampingMultiplier: p.cursorSpringDampingMultiplier, massMultiplier: p.cursorSpringMassMultiplier });
	});

	it("round-trips through storage and never restores blob: backgrounds", () => {
		const mem = new Map<string, string>();
		const store = { getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => void mem.set(k, v) };
		const s = defaultSettings();
		s.frame.padding = 33;
		s.frame.background = { kind: "image", url: "blob:abc" };
		saveSettings(s, store);
		const back = loadSettings(store);
		expect(back.frame.padding).toBe(33);
		expect(back.frame.background).toEqual({ kind: "image", url: "wallpapers/tahoe-light.jpg" });
	});
});
