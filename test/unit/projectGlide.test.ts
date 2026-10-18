import { describe, expect, it } from "vitest";
import { loadProjectZooms, loadProjectBrowserView, saveProjectZooms } from "../../src/editor/project";
import type { ZoomRegion } from "../../src/vendor/recordly/types";

function memoryStorage() {
	const data = new Map<string, string>();
	return { getItem: (key: string) => data.get(key) ?? null, setItem: (key: string, value: string) => { data.set(key, value); } };
}
const region: ZoomRegion = { id: "zoom-1", startMs: 500, endMs: 1500, depth: 3, focus: { cx: 0.2, cy: 0.8 }, mode: "manual" };

describe("recording-scoped zoom project", () => {
	it("distinguishes no project from a deliberately empty timeline", () => {
		const s = memoryStorage();
		expect(loadProjectZooms("a", 2000, s)).toBeNull();
		expect(saveProjectZooms("a", 2000, [], s)).toBe(true);
		expect(loadProjectZooms("a", 2000, s)).toEqual([]);
	});
	it("restores all edits without sharing references or other recordings", () => {
		const s = memoryStorage();
		saveProjectZooms("a", 2000, [region], s);
		const loaded = loadProjectZooms("a", 2000, s)!;
		expect(loaded).toEqual([region]);
		loaded[0].depth = 6;
		expect(loadProjectZooms("a", 2000, s)).toEqual([region]);
		expect(loadProjectZooms("b", 2000, s)).toBeNull();
		expect(loadProjectZooms("a", 5000, s)).toBeNull();
	});
	it.each([
		{ ...region, startMs: -1 },
		{ ...region, endMs: 2001 },
		{ ...region, endMs: 500 },
		{ ...region, depth: 7 },
		{ ...region, focus: { cx: 2, cy: 0.5 } },
		{ ...region, focus: { cx: null, cy: 0.5 } },
		{ ...region, mode: "other" },
		null,
	])("rejects malformed persisted regions: %j", (invalid) => {
		const s = { ...memoryStorage(), getItem: () => JSON.stringify({ version: 1, durationMs: 2000, regions: [invalid] }) };
		expect(loadProjectZooms("a", 2000, s)).toBeNull();
	});
	it("keeps browser top presentation per recording, with a full-source default", () => {
		const s = memoryStorage();
		expect(loadProjectBrowserView("a", 2000, s).hideTop).toBe(false);
		saveProjectZooms("a", 2000, [region], s, { startMs: 0, endMs: 2000 }, { hideTop: true, topPx: 123 });
		expect(loadProjectBrowserView("a", 2000, s)).toEqual({ hideTop: true, topPx: 123 });
		expect(loadProjectBrowserView("b", 2000, s).hideTop).toBe(false);
		expect(loadProjectBrowserView("a", 4000, s).hideTop).toBe(false);
		expect(loadProjectZooms("a", 2000, s)).toEqual([region]);
	});
	it("rejects duplicate IDs", () => {
		const s = memoryStorage();
		saveProjectZooms("a", 2000, [region, region], s);
		expect(loadProjectZooms("a", 2000, s)).toBeNull();
	});
	it("handles corrupted JSON and storage denial without throwing", () => {
		const s = { getItem: () => "{", setItem: () => { throw new Error("quota"); } };
		expect(loadProjectZooms("a", 2000, s)).toBeNull();
		expect(saveProjectZooms("a", 2000, [region], s)).toBe(false);
		const blocked = { getItem: () => { throw new Error("denied"); }, setItem: s.setItem };
		expect(loadProjectZooms("a", 2000, blocked)).toBeNull();
	});
});
