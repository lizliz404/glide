import type { Surface } from "./shared/types";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const bg = <T>(msg: object) => chrome.runtime.sendMessage<object, T>({ target: "background", ...msg });

type PointerMode = "tab" | "window" | "off";
interface Status {
	recording: boolean;
	since: number;
	events: number;
	pointer: PointerMode;
	surface: Surface;
}
interface Opts {
	mic: boolean;
	camera: boolean;
	surface: Surface;
}

const SURFACE_LABEL: Record<Surface, string> = { browser: "Tab", window: "Window", monitor: "Screen" };
const POINTER_LABEL: Record<PointerMode, string> = { tab: "Cursor: on", window: "Cursor: best-effort", off: "Cursor: off" };

const statusEl = $<HTMLElement>("status");
const elapsedEl = $<HTMLElement>("elapsed");
const surfaceEl = $<HTMLElement>("surface");
const pill = $<HTMLElement>("cursor-pill");
const dot = $<HTMLElement>("rec-dot");
const cam = $<HTMLVideoElement>("cam");
const camFallback = $<HTMLElement>("cam-fallback");
const micLabel = $<HTMLElement>("mic-label");
const micFill = $<HTMLElement>("mic-level");
const teleToggle = $<HTMLButtonElement>("tele-toggle");
const captureHint = $<HTMLElement>("capture-hint");
const stopBtn = $<HTMLButtonElement>("stop");

let recording = false;
let since = 0;
let opts: Opts = { mic: false, camera: false, surface: "browser" };
let poll = 0;
let clock = 0;
let meterRaf = 0;
let camStream: MediaStream | null = null;
let micStream: MediaStream | null = null;
let camOpening = false;
let micOpening = false;
let audioCtx: AudioContext | null = null;
let stopping = false;

function setStatus(msg: string) {
	statusEl.textContent = msg;
}

function fmt(ms: number) {
	const s = Math.max(0, Math.floor(ms / 1000));
	return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
}

function applyStatus(st: Status | null) {
	recording = !!st?.recording;
	since = st?.since || since;
	dot.hidden = !recording;
	dot.classList.toggle("live", recording);
	stopBtn.hidden = !recording;
	elapsedEl.textContent = recording ? fmt(Date.now() - since) : "—";
	const surface = st?.surface ?? opts.surface;
	surfaceEl.textContent = recording ? SURFACE_LABEL[surface] ?? surface : "";
	pill.hidden = !recording;
	pill.textContent = POINTER_LABEL[st?.pointer ?? "off"];
	pill.dataset.pointer = st?.pointer ?? "off";
	captureHint.hidden = surface === "browser";
	if (!recording && !stopping) setStatus("Not recording — press Record in the Glide popup.");
	else if (recording && !stopping) setStatus("Recording. Stop here when you are done — the editor opens next.");
	if (recording) startLoops();
	else stopLoops();
	void syncDevices();
}

async function refresh() {
	const st = await bg<Status>({ type: "status" }).catch(() => null);
	applyStatus(st);
}

function startLoops() {
	if (!poll) poll = window.setInterval(() => void refresh(), 1000);
	if (!clock) clock = window.setInterval(() => {
		if (recording) elapsedEl.textContent = fmt(Date.now() - since);
	}, 250);
}

function stopLoops() {
	clearInterval(poll);
	clearInterval(clock);
	poll = 0;
	clock = 0;
}

async function syncDevices() {
	const wantCam = recording && opts.camera;
	const wantMic = recording && opts.mic;
	if (wantCam && !camStream && !camOpening) await openCam();
	if (!wantCam) closeCam();
	if (wantMic && !micStream && !micOpening) await openMic();
	if (!wantMic) closeMic();
}

async function openCam() {
	camOpening = true;
	try {
		camStream = await navigator.mediaDevices.getUserMedia({ video: true });
		cam.srcObject = camStream;
		cam.hidden = false;
		camFallback.hidden = true;
	} catch {
		camFallback.textContent = "No camera access";
		camFallback.hidden = false;
		cam.hidden = true;
	} finally {
		camOpening = false;
	}
}

function closeCam() {
	camStream?.getTracks().forEach((t) => t.stop());
	camStream = null;
	cam.srcObject = null;
	cam.hidden = true;
	camFallback.textContent = opts.camera ? "Camera off" : "Camera off";
	camFallback.hidden = false;
}

async function openMic() {
	micOpening = true;
	try {
		micStream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true } });
		audioCtx = new AudioContext();
		const src = audioCtx.createMediaStreamSource(micStream);
		const analyser = audioCtx.createAnalyser();
		analyser.fftSize = 1024;
		src.connect(analyser);
		const data = new Float32Array(analyser.fftSize);
		micLabel.textContent = "Mic";
		let last = 0;
		const tick = (now: number) => {
			if (!micStream) return;
			if (now - last > 66) {
				analyser.getFloatTimeDomainData(data);
				let sum = 0;
				for (const n of data) sum += n * n;
				const rms = Math.sqrt(sum / data.length);
				micFill.style.width = `${Math.min(100, Math.round(rms * 280))}%`;
				last = now;
			}
			meterRaf = requestAnimationFrame(tick);
		};
		meterRaf = requestAnimationFrame(tick);
	} catch {
		micLabel.textContent = "No mic access";
	} finally {
		micOpening = false;
	}
}

function closeMic() {
	cancelAnimationFrame(meterRaf);
	meterRaf = 0;
	micStream?.getTracks().forEach((t) => t.stop());
	micStream = null;
	void audioCtx?.close();
	audioCtx = null;
	micFill.style.width = "0";
	micLabel.textContent = opts.mic ? "Mic off" : "Mic off";
}

async function syncTeleToggle() {
	const st = await bg<{ open: boolean }>({ type: "tele-state" }).catch(() => null);
	teleToggle.textContent = st?.open ? "Close teleprompter" : "Teleprompter";
	teleToggle.setAttribute("aria-pressed", String(!!st?.open));
}

async function restore() {
	const stored = await chrome.storage.local.get(["glideOpts", "glideRecording"]);
	if (stored.glideOpts) opts = stored.glideOpts as Opts;
	if (stored.glideRecording) startLoops();
	await refresh();
	void syncTeleToggle();
}

stopBtn.addEventListener("click", async () => {
	if (stopping) return;
	stopping = true;
	stopBtn.disabled = true;
	stopBtn.textContent = "Saving…";
	setStatus("Saving…");
	const res = await bg<{ ok?: boolean; error?: string }>({ type: "stop" }).catch((err: unknown) => ({
		ok: false,
		error: err instanceof Error ? err.message : "Could not stop",
	}));
	stopping = false;
	stopBtn.disabled = false;
	stopBtn.textContent = "Stop and edit";
	if (res && res.ok === false) {
		setStatus(`${res.error ?? "Could not stop"} — the recording is still running. Press Stop and edit again.`);
		return;
	}
	await refresh();
});

teleToggle.addEventListener("click", async () => {
	teleToggle.disabled = true;
	await bg({ type: "tele-toggle" }).catch(() => null);
	teleToggle.disabled = false;
	void syncTeleToggle();
});

chrome.storage.onChanged.addListener((changes, area) => {
	if (area !== "local") return;
	if (changes.glideOpts?.newValue) opts = changes.glideOpts.newValue as Opts;
	if (changes.glideRecording) void refresh();
});

window.addEventListener("beforeunload", (e) => {
	if (recording) e.preventDefault();
});
window.addEventListener("pagehide", () => {
	stopLoops();
	closeCam();
	closeMic();
});

restore();
