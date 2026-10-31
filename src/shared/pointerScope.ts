// Which tab/window a pointer event may be attributed to.
//
// Two provenance levels, depending on how the capture was started:
//
// - Tab capture goes through chrome.tabCapture.getMediaStreamId, so the recorder knows
//   the exact tabId being recorded. Pointer events are accepted only from that tab —
//   clicks in any other tab or window can never leak into the recording's zoom/cursor
//   data. This is the only mode where telemetry is fully trustworthy.
//
// - Window and screen capture go through getDisplayMedia, which never reveals which
//   surface the user picked. There is no verified identity, so Glide uses a focused-
//   window heuristic: events are accepted only from tabs inside the window the OS
//   currently reports as focused. While the user presents inside the recorded window
//   this is accurate; it degrades when they work across windows (best effort, not a
//   security boundary). Pointer positions outside any browser window are invisible to
//   extensions either way, so screen capture only follows the cursor inside Chrome.
//
// `sender` always comes from `chrome.runtime.onMessage` metadata, never from message
// fields, so a page cannot supply it.
export type PointerSource =
	| { kind: "unknown" }
	| { kind: "tab"; tabId: number }
	| { kind: "focused-window" };

/** No verified capture identity: nothing is trustworthy. */
export const UNKNOWN_SOURCE: PointerSource = { kind: "unknown" };

/** The subset of `chrome.runtime.MessageSender.tab` the rule needs. */
export interface SenderTabRef {
	id?: number;
	windowId?: number;
}

/**
 * True only when the message sender is inside the recorded surface.
 * `focusedWindowId` is the window the OS reports as focused right now (pushed to the
 * recorder by the service worker); it is ignored unless source.kind is "focused-window".
 */
export function acceptsPointerSender(
	source: PointerSource,
	sender: SenderTabRef | undefined,
	focusedWindowId: number | null,
): boolean {
	if (source.kind === "unknown") return false;
	if (source.kind === "tab") return sender?.id != null && sender.id === source.tabId;
	return focusedWindowId != null && sender?.windowId != null && sender.windowId === focusedWindowId;
}
