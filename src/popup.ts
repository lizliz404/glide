import { listRecordings } from "./shared/db";
import type { RecordOptions, Surface } from "./shared/types";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const startBtn = $<HTMLButtonElement>("start");
const stopBtn = $<HTMLButtonElement>("stop");
const status = $<HTMLElement>("status");
const mic = $<HTMLInputElement>("mic");
const camera = $<HTMLInputElement>("camera");
const surface = $<HTMLSelectElement>("surface");

const bg = <T = any>(msg: object) => chrome.runtime.sendMessage<object, T>({ target: "background", ...msg });

const SURFACE_LABEL: Record<Surface, string> = { browser: "Tab", window: "Window", monitor: "Screen" };
// One line per choice, so the note never describes a surface the user did not pick (P2-1).
const SURFACE_NOTE: Record<Surface, string> = {
	browser: "Stays locked to the tab you pick, with no browser chrome. Cleanest base for a demo.",
	window: "Follows tab switches in one window, but the browser chrome and the real cursor are baked into the video. Crop the top later in the editor.",
	monitor: "Records a whole screen, other apps included. The real cursor is baked into the video.",
};
const surfaceNote = $<HTMLParagraphElement>("surface-note");
const syncSurfaceNote = () => {
	surfaceNote.textContent = SURFACE_NOTE[surface.value as Surface] ?? SURFACE_NOTE.browser;
};

function timeAgo(at: number, now = Date.now()) {
	const mins = Math.round(Math.max(0, now - at) / 60000);
	if (mins < 1) return "just now";
	if (mins < 60) return `${mins} min ago`;
	const hours = Math.round(mins / 60);
	if (hours < 24) return `${hours} h ago`;
	const days = Math.round(hours / 24);
	return days === 1 ? "yesterday" : `${days} days ago`;
}

async function restore() {
	const { glideOpts } = (await chrome.storage.local.get("glideOpts")) as { glideOpts?: RecordOptions };
	if (glideOpts) {
		mic.checked = glideOpts.mic;
		camera.checked = glideOpts.camera;
		if (glideOpts.surface) surface.value = glideOpts.surface;
	}
	syncSurfaceNote();
	const st = await bg<{ recording: boolean; since: number; events: number }>({ type: "status" });
	setRecording(!!st?.recording, st?.since);
	const recent = await listRecordings().catch(() => []);
	const ul = $<HTMLUListElement>("recent");
	for (const r of recent.slice(0, 5)) {
		const li = document.createElement("li");
		const a = document.createElement("a");
		a.href = `editor.html?id=${encodeURIComponent(r.id)}`;
		a.target = "_blank";
		a.textContent = `${SURFACE_LABEL[r.surface] ?? r.surface} · ${(r.durationMs / 1000).toFixed(0)}s · ${new Date(r.createdAt).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })} · ${timeAgo(r.createdAt)}`;
		li.append(a);
		ul.append(li);
	}
	$("recent-wrap").hidden = recent.length === 0;
}

function setRecording(on: boolean, since = 0) {
	startBtn.hidden = on;
	stopBtn.hidden = !on;
	for (const el of [mic, camera, surface]) el.disabled = on;
	status.textContent = on ? `Recording since ${new Date(since).toLocaleTimeString()}` : "";
}

async function devicePermissionsOk(opts: RecordOptions) {
	const need: PermissionName[] = [];
	if (opts.mic) need.push("microphone" as PermissionName);
	if (opts.camera) need.push("camera" as PermissionName);
	for (const name of need) {
		const st = await navigator.permissions.query({ name }).catch(() => null);
		if (st && st.state !== "granted") return false;
	}
	return true;
}

startBtn.addEventListener("click", async () => {
	const opts: RecordOptions = { mic: mic.checked, camera: camera.checked, surface: surface.value as Surface };
	await chrome.storage.local.set({ glideOpts: opts });
	// Offscreen documents cannot show permission prompts, so mic/camera must be granted to
	// the extension origin once from a visible page.
	if (!(await devicePermissionsOk(opts))) {
		await chrome.tabs.create({ url: "setup.html" });
		return;
	}
	// Host access is optional and only used to log pointer positions while recording.
	await chrome.permissions.request({ origins: ["<all_urls>"] }).catch(() => false);
	// Tab and window capture need a visible page: tab capture stalls offscreen, and a
	// window recording has to follow the tabs the user switches to. Screen stays offscreen.
	if (opts.surface === "browser" || opts.surface === "window") {
		await bg({ type: "prepare-page", opts });
		window.close();
		return;
	}
	status.textContent = "Pick what to share in Chrome's dialog…";
	startBtn.disabled = true;
	const res = await bg<{ ok: boolean; error?: string; pointer?: boolean }>({ type: "start", opts });
	startBtn.disabled = false;
	if (res?.ok) {
		setRecording(true, Date.now());
		// Zoom and cursor need pointer data, which Glide only keeps when it can prove which
		// surface was captured (see src/shared/pointerScope.ts).
		status.textContent += " Zoom and cursor effects are off: Glide cannot verify which tab or window is being recorded.";
		return;
	}
	// Some Chrome builds refuse getDisplayMedia from an offscreen document without a direct
	// user gesture. Fall back to a visible recorder tab with its own Start button.
	if (res?.error && /NotAllowed|InvalidState|user gesture|activation|Timeout starting video source/i.test(res.error)) {
		await bg({ type: "prepare-page", opts });
		window.close();
		return;
	}
	status.textContent = res?.error ?? "Could not start recording";
});

stopBtn.addEventListener("click", async () => {
	stopBtn.disabled = true;
	status.textContent = "Saving…";
	const res = await bg<{ ok?: boolean; error?: string }>({ type: "stop" }).catch((err: unknown) => ({
		ok: false,
		error: err instanceof Error ? err.message : "Could not stop",
	}));
	if (res && res.ok === false) {
		stopBtn.disabled = false;
		status.textContent = res.error ?? "Could not stop";
		return;
	}
	window.close();
});

$("setup").addEventListener("click", (e) => {
	e.preventDefault();
	chrome.tabs.create({ url: "setup.html" });
});

surface.addEventListener("change", syncSurfaceNote);

restore();
