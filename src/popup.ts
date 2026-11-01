import { listRecordings, recoverOrphans } from "./shared/db";
import type { RecordOptions, Surface } from "./shared/types";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const startBtn = $<HTMLButtonElement>("start");
const stopBtn = $<HTMLButtonElement>("stop");
const pauseBtn = $<HTMLButtonElement>("pause");
let paused = false;
const status = $<HTMLElement>("status");
const mic = $<HTMLInputElement>("mic");
const camera = $<HTMLInputElement>("camera");
const surface = $<HTMLSelectElement>("surface");

const bg = <T = any>(msg: object) => chrome.runtime.sendMessage<object, T>({ target: "background", ...msg });

const SURFACE_LABEL: Record<Surface, string> = { browser: "Tab", window: "Window", monitor: "Screen" };
// One line per choice, so the note never describes a surface the user did not pick (P2-1).
const SURFACE_NOTE: Record<Surface, string> = {
	browser: "Records the tab you're on right now — no picker, no browser chrome, and cursor-follow zooms work fully.",
	window: "Follows tab switches in one window; the browser chrome and real cursor are baked into the video. Crop the top in the editor. Cursor effects follow the focused window (best effort).",
	monitor: "Records a whole screen, other apps included. The real cursor is baked into the video; cursor effects only track the pointer while it's over a browser window.",
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
	const st = await bg<{ recording: boolean; since: number; events: number; paused?: boolean; error?: string | null }>({ type: "status" });
	setRecording(!!st?.recording, st?.since, !!st?.paused);
	if (st?.error) status.textContent = st.error;
	// A recorder that closed or crashed mid-take left its chunks behind; turn them into a recording.
	const recovered = st?.recording ? [] : await recoverOrphans().catch(() => []);
	if (recovered.length) status.textContent = `Recovered ${recovered.length} unfinished recording${recovered.length > 1 ? "s" : ""} (no zoom/cursor data). Open it below.`;
	const recent = await listRecordings().catch(() => []);
	const ul = $<HTMLUListElement>("recent");
	for (const r of recent.slice(0, 5)) {
		const li = document.createElement("li");
		const a = document.createElement("a");
		a.href = `editor.html?id=${encodeURIComponent(r.id)}`;
		a.target = "_blank";
		a.title = new Date(r.createdAt).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
		a.textContent = `${SURFACE_LABEL[r.surface] ?? r.surface} · ${(r.durationMs / 1000).toFixed(0)}s · ${timeAgo(r.createdAt)}`;
		li.append(a);
		ul.append(li);
	}
	$("recent-wrap").hidden = recent.length === 0;
	$("intro").hidden = recent.length > 0;
	// Show each device's permission up front, so Record never surprises with a setup tab.
	for (const [name, el] of [["microphone", "mic-perm"], ["camera", "camera-perm"]] as const) {
		const st = await navigator.permissions.query({ name: name as PermissionName }).catch(() => null);
		$(el).textContent = !st ? "" : st.state === "granted" ? "· allowed" : st.state === "denied" ? "· blocked in Chrome settings" : "· asks once on Record";
	}
}

function setRecording(on: boolean, since = 0, isPaused = false) {
	paused = isPaused;
	startBtn.hidden = on;
	stopBtn.hidden = !on;
	pauseBtn.hidden = !on;
	pauseBtn.textContent = paused ? "Resume" : "Pause";
	for (const el of [mic, camera, surface]) el.disabled = on;
	status.textContent = !on ? "" : paused ? "Paused. The pause is cut from the video." : `Recording since ${new Date(since).toLocaleTimeString()}`;
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
	// Open the confidence panel (webcam preview, mic level, teleprompter, stop) in the
	// current window — this needs the Record click's user gesture.
	const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
	if (activeTab?.windowId != null) await chrome.sidePanel.open({ windowId: activeTab.windowId }).catch(() => {});
	// Single tab: capture via chrome.tabCapture on the tab the user is looking at —
	// no picker, exact pointer identity, no browser chrome in frame. Give the side
	// panel a beat to open first so its layout reflow doesn't land in the recording.
	if (opts.surface === "browser" && activeTab?.id != null) {
		await new Promise((r) => setTimeout(r, 350));
		const res = await bg<{ ok: boolean; error?: string; pointer?: boolean }>({ type: "start-tab", opts, tabId: activeTab.id });
		if (res?.ok) {
			setRecording(true, Date.now());
			status.textContent = "Recording this tab — your camera, mic level and teleprompter are in the side panel.";
			return;
		}
		// Any tabCapture/getUserMedia failure falls back to the picker-based recorder
		// page, which is strictly more general.
		if (res?.error && !/Already recording/i.test(res.error)) {
			await bg({ type: "prepare-page", opts });
			window.close();
			return;
		}
		status.textContent = res?.error ?? "Could not start recording";
		return;
	}
	// Window capture needs a visible page: the recording has to follow the tabs the
	// user switches to. Screen stays offscreen.
	if (opts.surface === "window") {
		await bg({ type: "prepare-page", opts });
		window.close();
		return;
	}
	status.textContent = "Pick what to share in Chrome's dialog…";
	startBtn.disabled = true;
	const res = await bg<{ ok: boolean; error?: string; pointer?: boolean; warnings?: string[] }>({ type: "start", opts });
	startBtn.disabled = false;
	if (res?.ok) {
		setRecording(true, Date.now());
		if (res.warnings?.length) status.textContent += ` ${res.warnings.join(" ")}`;
		// Picker-based screen capture uses the focused-window pointer heuristic —
		// follow effects work while the cursor is over a browser window.
		status.textContent += " Cursor effects follow the pointer inside the focused browser window (best effort).";
		return;
	}
	// Some Chrome builds refuse getDisplayMedia from an offscreen document without a direct
	// user gesture. Fall back to a visible recorder tab with its own Start button.
	if (res?.error && /NotAllowed|InvalidState|user gesture|activation|Timeout starting video source/i.test(res.error)) {
		await bg({ type: "prepare-page", opts });
		window.close();
		return;
	}
	const why = res?.error ?? "Could not start recording";
	status.textContent = /NotAllowed|permission/i.test(why)
		? "Chrome blocked the capture. Press Record and choose a source in the dialog."
		: `${why} — press Record to try again.`;
});

pauseBtn.addEventListener("click", async () => {
	pauseBtn.disabled = true;
	const res = await bg<{ ok: boolean; paused?: boolean; error?: string }>({ type: paused ? "resume" : "pause" });
	pauseBtn.disabled = false;
	if (res?.ok) setRecording(true, Date.now(), !!res.paused);
	else status.textContent = res?.error ?? "Could not pause";
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
		status.textContent = `${res.error ?? "Could not stop"} — the recording is still running. Press Stop and edit again.`;
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
