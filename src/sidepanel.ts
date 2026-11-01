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
const scriptEl = $<HTMLTextAreaElement>("script");
const prompter = $<HTMLElement>("prompter");
const presentBtn = $<HTMLButtonElement>("present");
const presentControls = $<HTMLElement>("present-controls");
const speed = $<HTMLInputElement>("speed");
const fontSize = $<HTMLInputElement>("fs");
const pauseScroll = $<HTMLButtonElement>("pause-scroll");
const popoutBtn = $<HTMLButtonElement>("tele-popout");
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
let scriptTimer = 0;
let teleTimer = 0;
let presenting = false;
let scrollPaused = false;
let scrollRaf = 0;

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
				micFill.style.setProperty("--lv", `${Math.min(100, Math.round(rms * 280))}%`);
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
	micFill.style.setProperty("--lv", "0%");
	micLabel.textContent = opts.mic ? "Mic off" : "Mic off";
}

// Inline teleprompter, docked in the panel's bottom space. The separate
// teleprompter.html window stays as a "Pop out" option for multi-monitor
// setups; it cannot overlay other windows on some Linux compositors, so
// this docked view is the default path.
function applyTelePrefs() {
	prompter.style.fontSize = `${fontSize.value}px`;
}

function queueScriptSave() {
	clearTimeout(scriptTimer);
	scriptTimer = window.setTimeout(() => void chrome.storage.local.set({ glideScript: scriptEl.value }), 400);
}

function queueTeleSave() {
	clearTimeout(teleTimer);
	teleTimer = window.setTimeout(() => {
		void chrome.storage.local.set({
			glideTele: { speed: Number(speed.value), fontSize: Number(fontSize.value), opacity: 100 },
		});
	}, 400);
}

function setPresent(on: boolean) {
	presenting = on;
	scriptEl.hidden = on;
	prompter.hidden = !on;
	presentControls.hidden = !on;
	presentBtn.textContent = on ? "Edit" : "Present";
	presentBtn.setAttribute("aria-pressed", String(on));
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
	// scrollTop writes round to whole pixels, so `+= subpixel delta` never
	// accumulates — keep our own position and resync on manual scrolls.
	let pos = prompter.scrollTop;
	const step = (now: number) => {
		if (!presenting) return;
		if (!scrollPaused && last) {
			const pxPerSec = Number(speed.value) || 28;
			pos += ((now - last) / 1000) * pxPerSec;
			prompter.scrollTop = pos;
		}
		if (Math.abs(prompter.scrollTop - pos) > 1) pos = prompter.scrollTop;
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

async function restore() {
	const stored = await chrome.storage.local.get(["glideOpts", "glideScript", "glideTele", "glideRecording"]);
	if (stored.glideOpts) opts = stored.glideOpts as Opts;
	if (typeof stored.glideScript === "string") scriptEl.value = stored.glideScript;
	if (stored.glideTele) {
		const t = stored.glideTele as { speed?: number; fontSize?: number };
		if (t.speed != null) speed.value = String(t.speed);
		if (t.fontSize != null) fontSize.value = String(t.fontSize);
	}
	applyTelePrefs();
	if (stored.glideRecording) startLoops();
	await refresh();
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

presentBtn.addEventListener("click", () => setPresent(!presenting));
pauseScroll.addEventListener("click", () => setScrollPaused(!scrollPaused));
speed.addEventListener("input", queueTeleSave);
fontSize.addEventListener("input", () => {
	applyTelePrefs();
	queueTeleSave();
});
scriptEl.addEventListener("input", queueScriptSave);
popoutBtn.addEventListener("click", async () => {
	popoutBtn.disabled = true;
	await bg({ type: "tele-toggle" }).catch(() => null);
	popoutBtn.disabled = false;
});

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
