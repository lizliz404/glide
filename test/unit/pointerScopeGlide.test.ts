import { describe, expect, it } from "vitest";
import { acceptsPointerSender, UNKNOWN_SOURCE, type PointerSource } from "../../src/shared/pointerScope";

// The rule that keeps QA P1-3 from coming back: an unverified capture identity accepts
// nothing, and a verified one accepts only the browser-reported sender, never message fields.
describe("pointer source attribution", () => {
	it("accepts nothing while the capture identity is unknown", () => {
		expect(acceptsPointerSender(UNKNOWN_SOURCE, { id: 7, windowId: 2 })).toBe(false);
		expect(acceptsPointerSender(UNKNOWN_SOURCE, undefined)).toBe(false);
	});

	it("accepts only the captured tab", () => {
		const tab: PointerSource = { kind: "tab", tabId: 7 };
		expect(acceptsPointerSender(tab, { id: 7, windowId: 2 })).toBe(true);
		// A click in another tab of the same window, or in another window, is not the recorded surface.
		expect(acceptsPointerSender(tab, { id: 8, windowId: 2 })).toBe(false);
		expect(acceptsPointerSender(tab, { id: 9, windowId: 5 })).toBe(false);
	});

	it("accepts tabs of the captured window only", () => {
		const win: PointerSource = { kind: "window", windowId: 5 };
		expect(acceptsPointerSender(win, { id: 11, windowId: 5 })).toBe(true);
		expect(acceptsPointerSender(win, { id: 12, windowId: 6 })).toBe(false);
		// windowId is required by the rule, so a sender without one cannot pass.
		expect(acceptsPointerSender(win, { id: 11 })).toBe(false);
	});

	it("rejects senders that carry no tab metadata", () => {
		expect(acceptsPointerSender({ kind: "tab", tabId: 7 }, undefined)).toBe(false);
		expect(acceptsPointerSender({ kind: "tab", tabId: 7 }, {})).toBe(false);
		expect(acceptsPointerSender({ kind: "window", windowId: 5 }, { windowId: 5 })).toBe(false);
	});
});
