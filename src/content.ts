// Pointer logger. Injected into every tab only while a recording is running (registered
// dynamically by the service worker, then unregistered), so Glide reads nothing from pages
// the rest of the time. It never reads page content: only pointer position, button state
// and the CSS cursor shape under the pointer.
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

	// CSS cursor keyword -> Recordly cursor-type key. Recordly's native monitors report the OS
	// cursor (e.g. Windows IDC_SIZEALL -> "open-hand"); the browser equivalent is the computed CSS
	// cursor of the element under the pointer. "url(...), pointer" falls back to its keyword.
	const CSS_CURSOR: Record<string, PointerEvt["cursor"]> = {
		pointer: "pointer",
		text: "text",
		"vertical-text": "text",
		grab: "open-hand",
		move: "open-hand",
		"all-scroll": "open-hand",
		grabbing: "closed-hand",
		crosshair: "crosshair",
		"ew-resize": "resize-ew",
		"col-resize": "resize-ew",
		"e-resize": "resize-ew",
		"w-resize": "resize-ew",
		"ns-resize": "resize-ns",
		"row-resize": "resize-ns",
		"n-resize": "resize-ns",
		"s-resize": "resize-ns",
		"not-allowed": "not-allowed",
		"no-drop": "not-allowed",
	};

	const cursorAt = (el: EventTarget | null): PointerEvt["cursor"] => {
		if (!(el instanceof Element)) return "arrow";
		const raw = getComputedStyle(el).cursor;
		const keyword = raw.slice(raw.lastIndexOf(",") + 1).trim();
		const mapped = CSS_CURSOR[keyword];
		if (mapped) return mapped;
		// "auto" over editable text shows an I-beam.
		if (keyword === "auto" && el.matches("input,textarea,[contenteditable='true']")) return "text";
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
	// Button 0 = primary, 1 = middle, 2 = right (MouseEvent.button), matching Recordly's
	// recordCursorMouseDown(1 | 2 | 3) split into click / middle-click / right-click.
	addEventListener(
		"mousedown",
		(e) => send(e, e.button === 2 ? "rightclick" : e.button === 1 ? "middleclick" : "down"),
		{ passive: true, capture: true },
	);
	addEventListener("mouseup", (e) => send(e, "up"), { passive: true, capture: true });
}
export {};
