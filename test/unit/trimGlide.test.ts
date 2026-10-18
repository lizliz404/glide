import { describe, expect, it } from "vitest";
import { fullTrim, setTrimEdge, validTrim } from "../../src/editor/trim";
import { loadProjectTrim, saveProjectZooms } from "../../src/editor/project";

describe("non-destructive retained range", () => {
	it("clamps crossed handles and allows reset without moving source time", () => {
		const range = { startMs: 1000, endMs: 2000 };
		expect(setTrimEdge(range, "start", 5000, 5000)).toEqual({ startMs: 1900, endMs: 2000 });
		expect(setTrimEdge(range, "end", 0, 5000)).toEqual({ startMs: 1000, endMs: 1100 });
		expect(setTrimEdge(range, "start", -10, 5000).startMs).toBe(0);
		expect(setTrimEdge(range, "end", 9000, 5000).endMs).toBe(5000);
		expect(fullTrim(5000)).toEqual({ startMs: 0, endMs: 5000 });
	});
	it("persists trim together with zooms but rejects corrupt/out-of-range data", () => {
		const data = new Map<string, string>();
		const s = { getItem: (key: string) => data.get(key) ?? null, setItem: (key: string, val: string) => { data.set(key, val); } };
		expect(loadProjectTrim("a", 5000, s)).toBeNull();
		saveProjectZooms("a", 5000, [], s);
		expect(loadProjectTrim("a", 5000, s)).toBeNull();
		const range = { startMs: 1000, endMs: 4000 };
		saveProjectZooms("a", 5000, [], s, range);
		expect(loadProjectTrim("a", 5000, s)).toEqual(range);
		expect(loadProjectTrim("b", 5000, s)).toBeNull();
		expect(loadProjectTrim("a", 3000, s)).toBeNull();
		for (const value of [null, {}, { startMs: -1, endMs: 4000 }, { startMs: 4000, endMs: 4000 }, { startMs: 0, endMs: 5001 }, { startMs: NaN, endMs: 4000 }]) expect(validTrim(value, 5000)).toBe(false);
	});
});
