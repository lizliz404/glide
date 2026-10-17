import { loadRecording } from "../shared/db";
import type { PointerEvt, RecordingMeta, Surface } from "../shared/types";
import { buildSegments, buildTrack, Camera, type Track, type ZoomSegment } from "./camera";
import { exportVideo, makeSeekable, type ExportResult } from "./export";
import { renderFrame } from "./render";
import { defaultSettings, GRADIENTS, outputSize, type Settings } from "./settings";

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const canvas = $<HTMLCanvasElement>("stage");
const ctx = canvas.getContext("2d")!;
const screenVid = document.createElement("video");
const camVid = document.createElement("video");
for (const v of [screenVid, camVid]) {
	v.playsInline = true;
	v.preload = "auto";
}
camVid.muted = true;

const state = {
	settings: (() => {
		try {
			return { ...defaultSettings(), ...JSON.parse(localStorage.getItem("glide.settings") ?? "{}") } as Settings;
		} catch {
			return defaultSettings();
		}
	})(),
	meta: null as RecordingMeta | null,
	screenBlob: null as Blob | null,
	camBlob: null as Blob | null,
	events: [] as PointerEvt[],
	track: { telemetry: [], clicks: [], cursorStyle: [] } as Track,
	segments: [] as ZoomSegment[],
	durationMs: 0,
	bgImage: null as HTMLImageElement | null,
	camera: null as Camera | null,
	lastFrameAt: 0,
};
if (state.settings.background.kind === "image") state.settings.background = defaultSettings().background;

const status = (msg: string) => ($("status").textContent = msg);

function recompute() {
	const surface: Surface = state.meta?.surface ?? "browser";
	state.track = buildTrack(state.events, surface);
	state.segments = buildSegments(state.track, state.settings.zoom, state.durationMs);
	if (state.camera) state.camera.update(state.track, state.segments, state.settings);
	else state.camera = new Camera(state.track, state.segments, state.settings);
	const { width, height } = outputSize(state.settings.aspect);
	if (canvas.width !== width || canvas.height !== height) {
		canvas.width = width;
		canvas.height = height;
	}
	drawTimeline();
	const { background: _b, ...persist } = state.settings;
	localStorage.setItem("glide.settings", JSON.stringify(persist));
}

function currentMs() {
	return screenVid.currentTime * 1000;
}

function draw(now = performance.now()) {
	const dt = state.lastFrameAt ? now - state.lastFrameAt : 16;
	state.lastFrameAt = now;
	const t = currentMs();
	if (state.meta?.hasCamera && Math.abs(camVid.currentTime - screenVid.currentTime) > 0.15) camVid.currentTime = screenVid.currentTime;
	renderFrame(ctx, canvas.width, canvas.height, {
		screen: screenVid.readyState >= 2 ? screenVid : null,
		camera: camVid.readyState >= 2 ? camVid : null,
		bgImage: state.bgImage,
		cam: state.camera!.frame(t, dt),
		track: state.track,
		t,
		settings: state.settings,
	});
	const scrub = $<HTMLInputElement>("scrub");
	if (document.activeElement !== scrub) scrub.value = String(t);
	$("time").textContent = `${fmt(t)} / ${fmt(state.durationMs)}`;
}

function loop(now: number) {
	draw(now);
	if (!screenVid.paused) requestAnimationFrame(loop);
}

const fmt = (ms: number) => {
	const s = Math.max(0, ms / 1000);
	return `${Math.floor(s / 60)}:${(s % 60).toFixed(1).padStart(4, "0")}`;
};

function drawTimeline() {
	const el = $("timeline");
	el.replaceChildren();
	const d = state.durationMs || 1;
	for (const s of state.segments) {
		const seg = document.createElement("div");
		seg.className = "seg";
		seg.style.left = `${(s.start / d) * 100}%`;
		seg.style.width = `${((s.end - s.start) / d) * 100}%`;
		seg.title = `Zoom ${fmt(s.start)}–${fmt(s.end)} (${s.clicks.length} click${s.clicks.length > 1 ? "s" : ""})`;
		el.append(seg);
	}
	for (const c of state.track.clicks) {
		const m = document.createElement("div");
		m.className = "click";
		m.style.left = `${(c.t / d) * 100}%`;
		el.append(m);
	}
	$<HTMLInputElement>("scrub").max = String(d);
	$("seg-count").textContent = `${state.segments.length} zoom${state.segments.length === 1 ? "" : "s"} from ${state.track.clicks.length} clicks`;
}

async function loadBundle(meta: RecordingMeta, screen: Blob, cam: Blob | null, events: PointerEvt[]) {
	status("Preparing recording…");
	const s = await makeSeekable(screen);
	const c = cam ? await makeSeekable(cam) : null;
	state.meta = meta;
	state.screenBlob = s.blob;
	state.camBlob = c?.blob ?? null;
	state.events = events;
	state.durationMs = s.durationMs || meta.durationMs;
	screenVid.src = URL.createObjectURL(s.blob);
	if (c) camVid.src = URL.createObjectURL(c.blob);
	// Tab capture usually has no OS cursor baked in, window/screen capture does.
	if (!localStorage.getItem("glide.cursorTouched")) state.settings.cursor.draw = meta.surface === "browser";
	bindControls();
	recompute();
	await new Promise((r) => screenVid.addEventListener("loadeddata", r, { once: true }));
	draw();
	status(`${meta.surface} capture · ${meta.width}×${meta.height} · ${fmt(state.durationMs)} · ${events.length} pointer events`);
	document.body.dataset.ready = "1";
}

async function init() {
	const p = new URLSearchParams(location.search);
	const id = p.get("id");
	try {
		if (id) {
			const b = await loadRecording(id);
			if (!b) throw new Error(`Recording ${id} not found`);
			await loadBundle(b.meta, b.screen, b.camera, b.events);
		} else if (p.get("src")) {
			// Dev/test entry: editor.html?src=screen.webm&cam=cam.webm&events=events.json
			const [screen, cam, ev] = await Promise.all([
				fetch(p.get("src")!).then((r) => r.blob()),
				p.get("cam") ? fetch(p.get("cam")!).then((r) => r.blob()) : null,
				p.get("events") ? fetch(p.get("events")!).then((r) => r.json()) : { meta: {}, events: [] },
			]);
			const meta: RecordingMeta = { id: "dev", createdAt: Date.now(), startedAt: 0, durationMs: 0, surface: "browser", width: 0, height: 0, hasCamera: !!cam, hasMic: false, ...ev.meta };
			await loadBundle(meta, screen, cam, ev.events);
		} else {
			$("empty").hidden = false;
			bindControls();
			recompute();
			draw();
			status("Open files to start");
		}
	} catch (e) {
		status(String(e));
	}
}

let bound = false;
function bindControls() {
	if (bound) return;
	bound = true;
	const S = state.settings;
	const num = (id: string, get: () => number, set: (v: number) => void, label?: (v: number) => string) => {
		const el = $<HTMLInputElement>(id);
		const out = document.querySelector<HTMLOutputElement>(`output[for="${id}"]`);
		el.value = String(get());
		if (out) out.value = label ? label(get()) : el.value;
		el.addEventListener("input", () => {
			set(Number(el.value));
			if (out) out.value = label ? label(Number(el.value)) : el.value;
			recompute();
			if (screenVid.paused) draw();
		});
	};
	const bool = (id: string, get: () => boolean, set: (v: boolean) => void) => {
		const el = $<HTMLInputElement>(id);
		el.checked = get();
		el.addEventListener("change", () => {
			set(el.checked);
			if (id === "cursor-draw") localStorage.setItem("glide.cursorTouched", "1");
			recompute();
			if (screenVid.paused) draw();
		});
	};
	const sel = (id: string, get: () => string, set: (v: string) => void) => {
		const el = $<HTMLSelectElement>(id);
		el.value = get();
		el.addEventListener("change", () => {
			set(el.value);
			recompute();
			if (screenVid.paused) draw();
		});
	};
	const pct = (v: number) => `${Math.round(v * 100)}%`;
	sel("aspect", () => S.aspect, (v) => (S.aspect = v as Settings["aspect"]));
	num("padding", () => S.padding, (v) => (S.padding = v), pct);
	num("radius", () => S.radius, (v) => (S.radius = v));
	num("shadow", () => S.shadow, (v) => (S.shadow = v), pct);
	bool("zoom-on", () => S.zoom.enabled, (v) => (S.zoom.enabled = v));
	num("zoom-scale", () => S.zoom.scale, (v) => (S.zoom.scale = v), (v) => `${v.toFixed(1)}×`);
	bool("zoom-follow", () => S.zoom.follow, (v) => (S.zoom.follow = v));
	sel("zoom-clicks", () => String(S.zoom.minClicks), (v) => (S.zoom.minClicks = Number(v)));
	num("zoom-hold", () => S.zoom.holdMs, (v) => (S.zoom.holdMs = v), (v) => `${(v / 1000).toFixed(1)}s`);
	bool("cursor-draw", () => S.cursor.draw, (v) => (S.cursor.draw = v));
	num("cursor-size", () => S.cursor.size, (v) => (S.cursor.size = v), (v) => `${v.toFixed(1)}×`);
	num("cursor-smooth", () => S.cursor.smoothing, (v) => (S.cursor.smoothing = v));
	bool("cursor-ripple", () => S.cursor.ripple, (v) => (S.cursor.ripple = v));
	bool("cam-show", () => S.webcam.show, (v) => (S.webcam.show = v));
	num("cam-size", () => S.webcam.size, (v) => (S.webcam.size = v), pct);
	sel("cam-corner", () => S.webcam.corner, (v) => (S.webcam.corner = v as Settings["webcam"]["corner"]));
	sel("cam-shape", () => S.webcam.shape, (v) => (S.webcam.shape = v as Settings["webcam"]["shape"]));
	bool("cam-mirror", () => S.webcam.mirror, (v) => (S.webcam.mirror = v));

	// Background swatches.
	const sw = $("swatches");
	for (const [name, stops] of Object.entries(GRADIENTS)) {
		const b = document.createElement("button");
		b.type = "button";
		b.className = "swatch";
		b.title = name;
		b.setAttribute("aria-label", `${name} gradient background`);
		b.style.background = `linear-gradient(135deg, ${stops.join(",")})`;
		b.addEventListener("click", () => {
			S.background = { kind: "gradient", stops };
			recompute();
			draw();
		});
		sw.append(b);
	}
	$<HTMLInputElement>("bg-color").addEventListener("input", (e) => {
		S.background = { kind: "color", color: (e.target as HTMLInputElement).value };
		recompute();
		draw();
	});
	$<HTMLInputElement>("bg-image").addEventListener("change", (e) => {
		const f = (e.target as HTMLInputElement).files?.[0];
		if (!f) return;
		const img = new Image();
		img.onload = () => {
			state.bgImage = img;
			S.background = { kind: "image", url: img.src };
			recompute();
			draw();
		};
		img.src = URL.createObjectURL(f);
	});

	// Transport.
	const play = $<HTMLButtonElement>("play");
	const toggle = () => {
		if (!state.screenBlob) return;
		if (screenVid.paused) {
			void screenVid.play();
			if (state.meta?.hasCamera) void camVid.play();
			state.lastFrameAt = 0;
			requestAnimationFrame(loop);
		} else {
			screenVid.pause();
			camVid.pause();
		}
	};
	play.addEventListener("click", toggle);
	screenVid.addEventListener("play", () => ((play.textContent = "Pause"), play.setAttribute("aria-pressed", "true")));
	screenVid.addEventListener("pause", () => ((play.textContent = "Play"), play.setAttribute("aria-pressed", "false")));
	screenVid.addEventListener("seeked", () => screenVid.paused && draw());
	camVid.addEventListener("seeked", () => screenVid.paused && draw());
	camVid.addEventListener("loadeddata", () => screenVid.paused && draw());
	document.addEventListener("keydown", (e) => {
		if (e.code === "Space" && !(e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement || e.target instanceof HTMLButtonElement)) {
			e.preventDefault();
			toggle();
		}
	});
	$<HTMLInputElement>("scrub").addEventListener("input", (e) => {
		const t = Number((e.target as HTMLInputElement).value) / 1000;
		screenVid.currentTime = t;
		if (state.meta?.hasCamera) camVid.currentTime = t;
	});

	// Local files (works without the extension too).
	$<HTMLInputElement>("open-files").addEventListener("change", async (e) => {
		const files = [...((e.target as HTMLInputElement).files ?? [])];
		const vids = files.filter((f) => f.type.startsWith("video/"));
		const json = files.find((f) => f.name.endsWith(".json"));
		if (!vids.length) return status("Pick at least one video file");
		const ev = json ? JSON.parse(await json.text()) : { meta: {}, events: [] };
		const screen = vids.find((v) => !/cam/i.test(v.name)) ?? vids[0];
		const cam = vids.find((v) => v !== screen) ?? null;
		$("empty").hidden = true;
		await loadBundle({ id: "local", createdAt: Date.now(), startedAt: 0, durationMs: 0, surface: "browser", width: 0, height: 0, hasCamera: !!cam, hasMic: false, ...ev.meta }, screen, cam, ev.events ?? []);
	});

	// Export.
	let ctrl: AbortController | null = null;
	const doExport = async (container: "mp4" | "webm") => {
		if (!state.screenBlob) return;
		ctrl = new AbortController();
		const prog = $<HTMLProgressElement>("progress");
		prog.hidden = false;
		$("cancel").hidden = false;
		const t0 = performance.now();
		try {
			const res = await runExport(container, (p) => {
				prog.value = p;
				status(`Exporting ${container.toUpperCase()}… ${Math.round(p * 100)}%`);
			}, ctrl.signal);
			const a = document.createElement("a");
			a.href = URL.createObjectURL(res.blob);
			a.download = `glide-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-")}.${container}`;
			a.click();
			status(`Exported ${res.width}×${res.height} ${container.toUpperCase()} (${res.videoCodec}${res.audioCodec ? ` + ${res.audioCodec}` : ""}, ${(res.blob.size / 1e6).toFixed(1)} MB) in ${((performance.now() - t0) / 1000).toFixed(1)}s`);
		} catch (err) {
			status(`Export failed: ${(err as Error).message}`);
		} finally {
			prog.hidden = true;
			$("cancel").hidden = true;
		}
	};
	$("export-mp4").addEventListener("click", () => doExport("mp4"));
	$("export-webm").addEventListener("click", () => doExport("webm"));
	$("cancel").addEventListener("click", () => ctrl?.abort());
}

function runExport(container: "mp4" | "webm", onProgress?: (p: number) => void, signal?: AbortSignal): Promise<ExportResult> {
	return exportVideo({
		container,
		fps: 30,
		screen: state.screenBlob!,
		camera: state.camBlob,
		bgImage: state.bgImage,
		track: state.track,
		segments: state.segments,
		settings: state.settings,
		durationMs: state.durationMs,
		onProgress,
		signal,
	});
}

// Test hook (used by test/e2e.mjs): export and hand back the bytes.
(window as unknown as { glide: object }).glide = {
	state,
	seek: async (ms: number) => {
		const vids = state.meta?.hasCamera ? [screenVid, camVid] : [screenVid];
		await Promise.all(
			vids.map(
				(v) =>
					new Promise<void>((r) => {
						v.addEventListener("seeked", () => r(), { once: true });
						v.currentTime = ms / 1000;
					}),
			),
		);
		draw();
	},
	export: async (container: "mp4" | "webm") => {
		const res = await runExport(container);
		const b = new Uint8Array(await res.blob.arrayBuffer());
		let s = "";
		for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000));
		return { b64: btoa(s), videoCodec: res.videoCodec, audioCodec: res.audioCodec };
	},
};

init();
