// Which tab/window a pointer event may be attributed to.
//
// Glide records with getDisplayMedia, and nothing in the current manifest (offscreen,
// storage, scripting plus optional host access) tells the recorder which surface the user
// picked. Measured on Chrome 154 (headless) while probing this:
//   - `chrome.tabCapture` and `chrome.desktopCapture` are `undefined` without their own
//     permissions, so no stream id / captured-tab list is reachable.
//   - Capture Handle returned null for a real tab capture with a `permittedOrigins: ["*"]`
//     allowlist, from both an isolated world and the main world, set before and after the
//     capture started, and for a plain page-to-page capture as well.
// So the recorder starts in `UNKNOWN_SOURCE` and every pointer event is dropped. That is
// deliberate: a tab A recording must not grow zooms or a drawn cursor from clicks that
// happened in tab B or in another window (docs/QA.md P1-3), and document visibility/focus
// cannot separate those two cases.
//
// The accept rule below is the only place that decides provenance. When an identity source
// is approved (for example a `tabCapture` stream id for single-tab recordings, or a Capture
// Handle verified on a headful build), pass its scope in here instead of `UNKNOWN_SOURCE`;
// events are then accepted only from that exact tab, or from tabs of that window.
// `sender` always comes from `chrome.runtime.onMessage` metadata, never from message fields,
// so a page cannot supply it.

export type PointerSource = { kind: "unknown" } | { kind: "tab"; tabId: number } | { kind: "window"; windowId: number };

/** No verified capture identity: nothing is trustworthy. */
export const UNKNOWN_SOURCE: PointerSource = { kind: "unknown" };

/** The subset of `chrome.runtime.MessageSender.tab` the rule needs. */
export interface SenderTabRef {
	id?: number;
	windowId?: number;
}

/** True only when the message sender is provably inside the recorded surface. */
export function acceptsPointerSender(source: PointerSource, sender: SenderTabRef | undefined): boolean {
	if (source.kind === "unknown") return false;
	if (sender?.id == null) return false;
	if (source.kind === "tab") return sender.id === source.tabId;
	return sender.windowId != null && sender.windowId === source.windowId;
}
