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

async function restore() {
	const { glideOpts } = (await chrome.storage.local.get("glideOpts")) as { glideOpts?: RecordOptions };
	if (glideOpts) {
		mic.checked = glideOpts.mic;
		camera.checked = glideOpts.camera;
		if (glideOpts.surface) surface.value = glideOpts.surface;
	}
	const st = await bg<{ recording: boolean; since: number; events: number }>({ type: "status" });
	setRecording(!!st?.recording, st?.since);
	const recent = await listRecordings().catch(() => []);
	const ul = $<HTMLUListElement>("recent");
	for (const r of recent.slice(0, 5)) {
		const li = document.createElement("li");
		const a = document.createElement("a");
		a.href = `editor.html?id=${encodeURIComponent(r.id)}`;
		a.target = "_blank";
		a.textContent = `${new Date(r.createdAt).toLocaleString()} · ${(r.durationMs / 1000).toFixed(0)}s · ${r.surface}`;
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
		if (!res.pointer) status.textContent += " (no cursor data: site access not granted)";
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

restore();
