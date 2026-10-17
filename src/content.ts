// Pointer logger. Injected into every tab only while a recording is running (registered
// dynamically by the service worker, then unregistered), so Glide reads nothing from pages
// the rest of the time. It never reads page content: only pointer position, button state
// and the coarse cursor style under the pointer.
import type { PointerEvt } from "./shared/types";

declare global {
	interface Window {
		__glideContent?: boolean;
	}
}

if (!window.__glideContent) {
	window.__glideContent = true;
	let active = false;
	let pending: MouseEvent | null = null;

	chrome.storage.local.get("glideRecording").then((v) => (active = !!v.glideRecording));
	chrome.storage.onChanged.addListener((c, area) => {
		if (area === "local" && "glideRecording" in c) active = !!c.glideRecording.newValue;
	});

	const cursorAt = (el: EventTarget | null): PointerEvt["cursor"] => {
		if (!(el instanceof Element)) return "arrow";
		const c = getComputedStyle(el).cursor;
		if (c === "pointer") return "pointer";
		if (c === "text" || el.matches("input,textarea,[contenteditable='true']")) return "text";
		return "arrow";
	};

	const send = (e: MouseEvent, kind: PointerEvt["kind"]) => {
		if (!active) return;
		// Mouse events carry screen coords; window.screenX/Y and outer size give the
		// window box. Chrome's window frame sits at the top, so this is close but not
		// pixel-exact for window capture (documented in README limitations).
		const sw = screen.width || 1;
		const sh = screen.height || 1;
		const left = (screen as Screen & { availLeft?: number }).availLeft ?? 0;
		const top = (screen as Screen & { availTop?: number }).availTop ?? 0;
		const evt: PointerEvt = {
			t: Date.now(),
			kind,
			tab: [e.clientX / innerWidth, e.clientY / innerHeight],
			win: [(e.screenX - screenX) / outerWidth, (e.screenY - screenY) / outerHeight],
			mon: [(e.screenX - left) / sw, (e.screenY - top) / sh],
			cursor: cursorAt(e.target),
		};
		chrome.runtime.sendMessage({ target: "recorder", type: "pointer", evt }).catch(() => {});
	};

	// Coalesce moves to one per animation frame (~60 Hz) to keep message volume sane.
	addEventListener(
		"mousemove",
		(e) => {
			if (!active) return;
			if (!pending) requestAnimationFrame(() => pending && (send(pending, "move"), (pending = null)));
			pending = e;
		},
		{ passive: true, capture: true },
	);
	addEventListener("mousedown", (e) => send(e, "down"), { passive: true, capture: true });
	addEventListener("mouseup", (e) => send(e, "up"), { passive: true, capture: true });
}
export {};
