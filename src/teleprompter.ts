// Floating teleprompter window. Lives outside any captured surface (its own
// chrome.windows popup), so it never lands inside a tab or window recording.
// All controls persist: text -> glideScript, sliders -> glideTele, bounds -> glideTeleBounds.
const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const scriptEl = $<HTMLTextAreaElement>("script");
const prompter = $<HTMLElement>("prompter");
const editBtn = $<HTMLButtonElement>("edit");
const speed = $<HTMLInputElement>("speed");
const fontSize = $<HTMLInputElement>("fs");
const teleOpacity = $<HTMLInputElement>("tele-opacity");
const pauseScroll = $<HTMLButtonElement>("pause-scroll");
const dragBar = $<HTMLElement>("drag");

let presenting = false;
let scrollPaused = false;
let scrollRaf = 0;
let scriptTimer = 0;
let teleTimer = 0;
let boundsTimer = 0;

function applyTelePrefs() {
	prompter.style.fontSize = `${fontSize.value}px`;
	prompter.style.opacity = String(Number(teleOpacity.value) / 100);
}

function queueScriptSave() {
	clearTimeout(scriptTimer);
	scriptTimer = window.setTimeout(() => void chrome.storage.local.set({ glideScript: scriptEl.value }), 400);
}

function queueTeleSave() {
	clearTimeout(teleTimer);
	teleTimer = window.setTimeout(() => {
		void chrome.storage.local.set({
			glideTele: { speed: Number(speed.value), fontSize: Number(fontSize.value), opacity: Number(teleOpacity.value) },
		});
	}, 400);
}

function setPresent(on: boolean) {
	presenting = on;
	scriptEl.hidden = on;
	prompter.hidden = !on;
	editBtn.textContent = on ? "Edit" : "Present";
	if (on) {
		prompter.textContent = scriptEl.value || "No script yet.";
		prompter.scrollTop = 0;
		setScrollPaused(false);
		startScroll();
		prompter.focus();
	} else {
		stopScroll();
		scriptEl.focus();
	}
}

function startScroll() {
	stopScroll();
	let last = 0;
	const step = (now: number) => {
		if (!presenting) return;
		if (!scrollPaused && last) {
			const pxPerSec = Number(speed.value) || 28;
			prompter.scrollTop += ((now - last) / 1000) * pxPerSec;
		}
		last = now;
		scrollRaf = requestAnimationFrame(step);
	};
	scrollRaf = requestAnimationFrame(step);
}

function stopScroll() {
	cancelAnimationFrame(scrollRaf);
	scrollRaf = 0;
}

function setScrollPaused(on: boolean) {
	scrollPaused = on;
	pauseScroll.textContent = scrollPaused ? "Resume" : "Pause";
	pauseScroll.setAttribute("aria-pressed", String(scrollPaused));
}

editBtn.addEventListener("click", () => setPresent(!presenting));
pauseScroll.addEventListener("click", () => setScrollPaused(!scrollPaused));
speed.addEventListener("input", queueTeleSave);
fontSize.addEventListener("input", () => {
	applyTelePrefs();
	queueTeleSave();
});
teleOpacity.addEventListener("input", () => {
	applyTelePrefs();
	queueTeleSave();
});
scriptEl.addEventListener("input", queueScriptSave);

document.addEventListener("keydown", (e) => {
	const editing = e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement;
	if (e.key === "Escape" && !editing) {
		setPresent(false);
		return;
	}
	if (!presenting || editing) return;
	if (e.key === " ") {
		e.preventDefault();
		setScrollPaused(!scrollPaused);
	} else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
		e.preventDefault();
		prompter.scrollTop += e.key === "ArrowDown" ? 72 : -72;
	}
});

// Drag the floating window by its bar: pointer deltas in screen coords map 1:1
// to window left/top. Resize is native (window edge drag).
let drag: { pointerId: number; offX: number; offY: number; winId: number } | null = null;
dragBar.addEventListener("pointerdown", async (e) => {
	if ((e.target as HTMLElement).closest("button")) return;
	const win = await chrome.windows.getCurrent();
	if (win.id == null) return;
	drag = { pointerId: e.pointerId, offX: e.screenX - (win.left ?? 0), offY: e.screenY - (win.top ?? 0), winId: win.id };
	dragBar.setPointerCapture(e.pointerId);
});
dragBar.addEventListener("pointermove", (e) => {
	if (!drag || e.pointerId !== drag.pointerId) return;
	void chrome.windows.update(drag.winId, { left: Math.round(e.screenX - drag.offX), top: Math.round(e.screenY - drag.offY) });
});
const endDrag = (e: PointerEvent) => {
	if (drag && e.pointerId === drag.pointerId) drag = null;
};
dragBar.addEventListener("pointerup", endDrag);
dragBar.addEventListener("pointercancel", endDrag);

// Remember bounds so the next session opens where the user left it.
chrome.windows.onBoundsChanged.addListener((win) => {
	void chrome.windows.getCurrent().then((self) => {
		if (self.id !== win.id) return;
		clearTimeout(boundsTimer);
		boundsTimer = window.setTimeout(() => {
			void chrome.storage.local.set({
				glideTeleBounds: { left: win.left, top: win.top, width: win.width, height: win.height },
			});
		}, 300);
	});
});

async function restore() {
	const stored = await chrome.storage.local.get(["glideScript", "glideTele"]);
	if (typeof stored.glideScript === "string") scriptEl.value = stored.glideScript;
	if (stored.glideTele) {
		const t = stored.glideTele as { speed?: number; fontSize?: number; opacity?: number };
		if (t.speed != null) speed.value = String(t.speed);
		if (t.fontSize != null) fontSize.value = String(t.fontSize);
		if (t.opacity != null) teleOpacity.value = String(t.opacity);
	}
	applyTelePrefs();
	// A script exists -> open straight into present mode; empty -> edit mode.
	setPresent(!!scriptEl.value.trim());
}

restore();
