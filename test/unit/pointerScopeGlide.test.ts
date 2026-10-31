import { describe, expect, it } from "vitest";
import { acceptsPointerSender, UNKNOWN_SOURCE, type PointerSource } from "../../src/shared/pointerScope";

// The rule that keeps QA P1-3 from coming back: tab capture accepts only the recorded
// tab, picker captures accept only the currently focused window, and an unverified
// identity accepts nothing. `sender` is Chrome's message metadata, never message fields.
describe("pointer source attribution", () => {
	it("accepts nothing while the capture identity is unknown", () => {
		expect(acceptsPointerSender(UNKNOWN_SOURCE, { id: 7, windowId: 2 }, null)).toBe(false);
		expect(acceptsPointerSender(UNKNOWN_SOURCE, { id: 7, windowId: 2 }, 2)).toBe(false);
		expect(acceptsPointerSender(UNKNOWN_SOURCE, undefined, 2)).toBe(false);
		expect(acceptsPointerSender(UNKNOWN_SOURCE, undefined, null)).toBe(false);
	});

	it("accepts only the captured tab", () => {
		const tab: PointerSource = { kind: "tab", tabId: 7 };
		expect(acceptsPointerSender(tab, { id: 7, windowId: 2 }, null)).toBe(true);
		// A click in another tab of the same window, or in another window, is not the recorded surface.
		expect(acceptsPointerSender(tab, { id: 8, windowId: 2 }, null)).toBe(false);
		expect(acceptsPointerSender(tab, { id: 9, windowId: 5 }, null)).toBe(false);
		// TAB_ID_NONE-style negative ids are never the recorded tab.
		expect(acceptsPointerSender(tab, { id: -1, windowId: 2 }, null)).toBe(false);
	});

	it("ignores the focused window for exact-tab capture", () => {
		const tab: PointerSource = { kind: "tab", tabId: 7 };
		// A focused-window value must not widen or narrow exact-tab identity.
		expect(acceptsPointerSender(tab, { id: 7, windowId: 2 }, 999)).toBe(true);
		expect(acceptsPointerSender(tab, { id: 8, windowId: 999 }, 999)).toBe(false);
	});

	it("accepts senders from the focused window only", () => {
		const win: PointerSource = { kind: "focused-window" };
		expect(acceptsPointerSender(win, { id: 11, windowId: 5 }, 5)).toBe(true);
		expect(acceptsPointerSender(win, { id: 12, windowId: 6 }, 5)).toBe(false);
		// windowId is required by the rule, so a sender without one cannot pass.
		expect(acceptsPointerSender(win, { id: 11 }, 5)).toBe(false);
	});

	it("rejects everything while no window is focused", () => {
		const win: PointerSource = { kind: "focused-window" };
		// focusedWindowId is null when Chrome reports WINDOW_ID_NONE (no focused window).
		expect(acceptsPointerSender(win, { id: 11, windowId: 5 }, null)).toBe(false);
		expect(acceptsPointerSender(win, { id: 11 }, null)).toBe(false);
		expect(acceptsPointerSender(win, undefined, null)).toBe(false);
	});

	it("rejects senders that carry no tab metadata", () => {
		expect(acceptsPointerSender({ kind: "tab", tabId: 7 }, undefined, null)).toBe(false);
		expect(acceptsPointerSender({ kind: "tab", tabId: 7 }, {}, null)).toBe(false);
		expect(acceptsPointerSender({ kind: "focused-window" }, undefined, 5)).toBe(false);
		expect(acceptsPointerSender({ kind: "focused-window" }, {}, 5)).toBe(false);
	});

	it("rejects WINDOW_ID_NONE-style negative ids", () => {
		// A sender Chrome could not place in any window (windowId -1) is never in scope,
		// and a negative focused-window id accepts no real sender.
		expect(acceptsPointerSender({ kind: "focused-window" }, { id: 11, windowId: -1 }, 5)).toBe(false);
		expect(acceptsPointerSender({ kind: "focused-window" }, { id: 11, windowId: 5 }, -1)).toBe(false);
		expect(acceptsPointerSender({ kind: "tab", tabId: 7 }, { id: -1, windowId: 5 }, null)).toBe(false);
	});
});
