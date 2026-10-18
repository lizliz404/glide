// Glide editor: Recordly's editor flow in a browser page. Auto zoom regions on load
// (useFreshRecordingAutoZoom), a timeline of zoom blocks, sidebar sections Look / Motion plus a
// contextual zoom panel (EditorSidebar + SettingsPanel), and one compositor for preview and export.
import { loadRecording } from "../shared/db";
import type { PointerEvt, RecordingMeta, Surface } from "../shared/types";
import type { CursorMotionPresetId } from "../vendor/recordly/cursorMotionPresets";
import { fromCursorSwaySliderValue, toCursorSwaySliderValue } from "../vendor/recordly/cursorSway";
import {
	type CursorClickEffectStyle,
	type CursorTelemetryPoint,
	DEFAULT_ZOOM_DEPTH,
	type WebcamPositionPreset,
	ZOOM_DEPTH_SCALES,
	type ZoomDepth,
	type ZoomRegion,
} from "../vendor/recordly/types";
import { getWebcamPositionForPreset } from "../vendor/recordly/webcamOverlay";
import { suggestZoomRegions } from "./camera";
import { Compositor } from "./compose";
import { preloadCursorAssets } from "./cursor";
import { exportVideo, makeSeekable, type ExportResult } from "./export";
import { computeFrameLayout, FRAME_DEFAULTS, WALLPAPERS } from "./frame";
import { applyMotionPreset, defaultSettings, loadSettings, outputSize, saveSettings, type Aspect, type GlideSettings } from "./settings";
import { toTelemetry } from "./telemetry";
import { loadProjectZooms, loadProjectTrim, loadProjectBrowserView, saveProjectZooms } from "./project";
import { browserCrop, normalizeBrowserView } from "./browserView";
import { fullTrim, setTrimEdge, type TrimRange } from "./trim";

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

const POSITIONS: WebcamPositionPreset[] = ["top-left", "top-center", "top-right", "center-left", "center", "center-right", "bottom-left", "bottom-center", "bottom-right"];
const MIN_REGION_MS = 250;
const NEW_REGION_MS = 1000;

const state = {
	settings: loadSettings(),
	meta: null as RecordingMeta | null,
	screenBlob: null as Blob | null,
	camBlob: null as Blob | null,
	events: [] as PointerEvt[],
	telemetry: [] as CursorTelemetryPoint[],
	regions: [] as ZoomRegion[],
	projectId: null as string | null,
	selectedId: null as string | null,
	durationMs: 0,
	trim: fullTrim(0),
	browserView: normalizeBrowserView(null),
	bgImage: null as HTMLImageElement | null,
	bgUrl: "",
	section: "scene",
};
const comp = new Compositor(state.settings);
/** True while an export owns the page; export and file-import actions are locked out. */
let exporting = false;
const status = (msg: string) => ($("status").textContent = msg);
const fmt = (ms: number) => {
	const s = Math.max(0, ms / 1000);
	return `${Math.floor(s / 60)}:${(s % 60).toFixed(1).padStart(4, "0")}`;
};
const currentMs = () => screenVid.currentTime * 1000;
const scene = () => ({ telemetry: state.telemetry, regions: state.regions, videoW: screenVid.videoWidth || state.meta?.width || 0, videoH: screenVid.videoHeight || state.meta?.height || 0,
	crop: browserCrop(state.browserView, screenVid.videoHeight || state.meta?.height || 0, state.meta?.surface) });
const hasCam = () => !!state.camBlob;

// ------------------------------------------------------------------------------------------------
// Drawing

function ensureBackgroundImage() {
	const bg = state.settings.frame.background;
	if (bg.kind !== "image" || bg.url === state.bgUrl) return;
	state.bgUrl = bg.url;
	const img = new Image();
	img.onload = () => {
		if (state.bgUrl !== bg.url) return;
		state.bgImage = img;
		redraw();
	};
	img.src = bg.url;
}

/** snap = exact target (paused frame, seek); otherwise springs advance by the content-time delta. */
function draw(snap: boolean) {
	const { width, height } = outputSize(state.settings.aspect);
	if (canvas.width !== width || canvas.height !== height) {
		canvas.width = width;
		canvas.height = height;
	}
	const t = currentMs();
	if (hasCam() && Math.abs(camVid.currentTime - screenVid.currentTime) > 0.15) camVid.currentTime = screenVid.currentTime;
	comp.draw(
		ctx,
		width,
		height,
		t,
		{
			screen: screenVid.readyState >= 2 ? screenVid : null,
			cam: hasCam() && camVid.readyState >= 2 ? camVid : null,
			camW: camVid.videoWidth,
			camH: camVid.videoHeight,
			bgImage: state.bgImage,
		},
		scene(),
		snap,
	);
	updatePlayhead(t);
}
const redraw = () => screenVid.paused && draw(true);

function loop() {
	if (currentMs() >= state.trim.endMs) {
		screenVid.pause();
		camVid.pause();
		seekTo(state.trim.endMs);
		return;
	}
	draw(false);
	if (!screenVid.paused) requestAnimationFrame(loop);
}

// ------------------------------------------------------------------------------------------------
// Settings plumbing

function settingsChanged(opts: { rebind?: boolean } = {}) {
	comp.setSettings(state.settings);
	saveSettings(state.settings);
	ensureBackgroundImage();
	if (opts.rebind) syncControls();
	syncPickers();
	redraw();
}

type Binding = { sync: () => void };
const bindings: Binding[] = [];

function range(id: string, get: () => number, set: (v: number) => void, label: (v: number) => string = (v) => String(v)) {
	const el = $<HTMLInputElement>(id);
	const out = document.querySelector<HTMLOutputElement>(`output[for="${id}"]`);
	const sync = () => {
		el.value = String(get());
		if (out) out.value = label(get());
	};
	el.addEventListener("input", () => {
		set(Number(el.value));
		if (out) out.value = label(Number(el.value));
		settingsChanged();
	});
	bindings.push({ sync });
}
function check(id: string, get: () => boolean, set: (v: boolean) => void) {
	const el = $<HTMLInputElement>(id);
	el.addEventListener("change", () => {
		set(el.checked);
		settingsChanged();
	});
	bindings.push({ sync: () => (el.checked = get()) });
}
function radios(container: HTMLElement, get: () => string, set: (v: string) => void) {
	const buttons = () => [...container.querySelectorAll<HTMLButtonElement>("[role=radio]")];
	container.addEventListener("click", (e) => {
		const b = (e.target as HTMLElement).closest<HTMLButtonElement>("[role=radio]");
		if (!b || !container.contains(b)) return;
		set(b.dataset.value!);
		settingsChanged();
	});
	container.addEventListener("keydown", (e) => {
		if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(e.key)) return;
		const list = buttons();
		const i = list.findIndex((b) => b.getAttribute("aria-checked") === "true");
		const next = list[(i + (e.key === "ArrowLeft" || e.key === "ArrowUp" ? list.length - 1 : 1)) % list.length];
		e.preventDefault();
		next.click();
		next.focus();
	});
	const sync = () => {
		for (const b of buttons()) {
			const on = b.dataset.value === get();
			b.setAttribute("aria-checked", String(on));
			b.tabIndex = on ? 0 : -1;
		}
	};
	bindings.push({ sync });
	return sync;
}
function syncControls() {
	for (const b of bindings) b.sync();
}

const pct = (v: number) => `${Math.round(v * 100)}%`;

function syncPickers() {
	// Older storage may still hold a colour or gradient background: it keeps rendering, but
	// wallpapers are the only visible picker, so no swatch is checked until the user picks one.
	const bg = state.settings.frame.background;
	const value = bg.kind === "image" ? bg.url : "";
	for (const b of document.querySelectorAll<HTMLButtonElement>("#wallpapers [role=radio]")) b.setAttribute("aria-checked", String(b.dataset.value === value));
	$("webcam-none").hidden = hasCam();
}

function bindControls() {
	const S = () => state.settings;
	// Scene: background
	const swatch = (parent: string, value: string, css: string, label: string) => {
		const b = document.createElement("button");
		b.type = "button";
		b.setAttribute("role", "radio");
		b.dataset.value = value;
		b.title = label;
		b.setAttribute("aria-label", label);
		b.style.background = css;
		if (css.startsWith("url(")) b.style.backgroundSize = "cover";
		$(parent).append(b);
		return b;
	};
	for (const w of WALLPAPERS) swatch("wallpapers", w.url, `url("${w.url}") center / cover`, w.label).addEventListener("click", () => {
		S().frame.background = { kind: "image", url: w.url };
		settingsChanged();
	});
	$<HTMLInputElement>("bg-upload").addEventListener("change", (e) => {
		const f = (e.target as HTMLInputElement).files?.[0];
		if (!f) return;
		S().frame.background = { kind: "image", url: URL.createObjectURL(f) };
		settingsChanged();
	});
	// Visible frame choices are presets; Recordly's full ranges stay bound and stored below.
	check("frame-shadow-toggle", () => S().frame.shadowIntensity > 0, (v) => (S().frame.shadowIntensity = v ? FRAME_DEFAULTS.shadowIntensity : 0));
	radios($("frame-padding-presets"), () => String(S().frame.padding), (v) => (S().frame.padding = Number(v)));
	range("bg-blur", () => S().frame.backgroundBlur, (v) => (S().frame.backgroundBlur = v));
	range("frame-shadow", () => S().frame.shadowIntensity, (v) => (S().frame.shadowIntensity = v), pct);
	range("frame-radius", () => S().frame.borderRadius, (v) => (S().frame.borderRadius = v), (v) => v.toFixed(1));
	range("frame-padding", () => S().frame.padding, (v) => (S().frame.padding = v), (v) => `${Math.round(v)}%`);

	// Presentation is recording-scoped, independent of capture mode and global styling.
	const hideTop = $<HTMLInputElement>("browser-hide-top");
	const topPx = $<HTMLInputElement>("browser-top-px");
	const syncBrowserView = () => {
		// A single-tab capture has no browser chrome, so the control is disabled and the render guard
		// in browserCrop() keeps the full frame even when an old project persisted hideTop: true.
		const tabCapture = state.meta?.surface === "browser";
		hideTop.checked = !tabCapture && state.browserView.hideTop;
		hideTop.disabled = !state.screenBlob || tabCapture;
		topPx.disabled = !state.screenBlob || tabCapture;
		$("browser-top-controls").hidden = tabCapture || !state.browserView.hideTop;
		topPx.max = String(Math.max(0, (screenVid.videoHeight || state.meta?.height || 1) - 1));
		topPx.value = String(Math.min(state.browserView.topPx, Number(topPx.max)));
		document.querySelector<HTMLOutputElement>('output[for="browser-top-px"]')!.value = `${topPx.value} px`;
		$("browser-top-hint").textContent = tabCapture
			? "This is a single-tab recording, so there is no browser chrome to hide. Record a whole browser window to keep or hide the tab strip, address bar and toolbar."
			: "Keep or hide the recorded tab strip, address bar and toolbar. Adjust height to your browser; this also changes the preview. The source stays intact.";
	};
	const browserViewChanged = () => {
		state.browserView = normalizeBrowserView({ hideTop: hideTop.checked, topPx: Number(topPx.value) });
		saveProject();
		syncBrowserView();
		comp.reset();
		if (screenVid.readyState >= 2) draw(true);
	};
	hideTop.addEventListener("change", () => { topPx.value = String(state.browserView.topPx); browserViewChanged(); });
	topPx.addEventListener("input", browserViewChanged);
	bindings.push({ sync: syncBrowserView });

	// Cursor
	check("cursor-show", () => S().cursor.show, (v) => {
		S().cursor.show = v;
		localStorage.setItem("glide.cursorTouched", "1");
	});
	const style = $<HTMLSelectElement>("cursor-style");
	style.addEventListener("change", () => {
		S().cursor.style = style.value;
		settingsChanged();
	});
	bindings.push({ sync: () => (style.value = S().cursor.style) });
	range("cursor-size", () => S().cursor.size, (v) => (S().cursor.size = v), (v) => `${v.toFixed(2)}×`);
	range("cursor-smoothing", () => S().cursor.smoothing, (v) => (S().cursor.smoothing = v), (v) => v.toFixed(2));
	radios($("click-effects"), () => S().cursor.clickEffect, (v) => (S().cursor.clickEffect = v as CursorClickEffectStyle));
	const color = $<HTMLInputElement>("click-color");
	color.addEventListener("input", () => {
		S().cursor.clickEffectColor = color.value;
		settingsChanged();
	});
	bindings.push({ sync: () => (color.value = S().cursor.clickEffectColor) });
	range("cursor-bounce", () => S().cursor.clickBounce, (v) => (S().cursor.clickBounce = v), (v) => `${v.toFixed(2)}×`);
	range("cursor-bounce-ms", () => S().cursor.clickBounceDuration, (v) => (S().cursor.clickBounceDuration = v), (v) => `${Math.round(v)} ms`);
	range("cursor-sway", () => toCursorSwaySliderValue(S().cursor.sway), (v) => (S().cursor.sway = fromCursorSwaySliderValue(v)), pct);

	// Webcam
	check("webcam-show", () => S().webcam.enabled, (v) => (S().webcam.enabled = v));
	range("webcam-size", () => S().webcam.sizePercent, (v) => (S().webcam.sizePercent = v), (v) => `${Math.round(v)}%`);
	range("webcam-roundness", () => S().webcam.roundness, (v) => (S().webcam.roundness = v), (v) => `${Math.round(v)}%`);
	range("webcam-shadow", () => S().webcam.shadow, (v) => (S().webcam.shadow = v), pct);
	const pos = $("webcam-pos");
	for (const p of POSITIONS) {
		const b = document.createElement("button");
		b.type = "button";
		b.setAttribute("role", "radio");
		b.dataset.value = p;
		b.setAttribute("aria-label", p.replace("-", " "));
		b.title = p.replace("-", " ");
		pos.append(b);
	}
	radios(pos, () => S().webcam.positionPreset, (v) => {
		const p = getWebcamPositionForPreset(v as WebcamPositionPreset);
		Object.assign(S().webcam, { positionPreset: v, positionX: p.x, positionY: p.y });
	});
	check("webcam-mirror", () => S().webcam.mirror, (v) => (S().webcam.mirror = v));
	check("webcam-react", () => S().webcam.reactToZoom, (v) => (S().webcam.reactToZoom = v));

	// Settings
	radios($("motion-presets"), () => S().motionPreset, (v) => {
		applyMotionPreset(S(), v as CursorMotionPresetId);
		queueMicrotask(syncControls);
	});
	check("connect-zooms", () => S().zoom.connectZooms, (v) => (S().zoom.connectZooms = v));
	check("auto-apply", () => S().autoApplyZooms, (v) => (S().autoApplyZooms = v));
	$("reset-defaults").addEventListener("click", () => {
		const keepCursor = state.settings.cursor.show;
		state.settings = defaultSettings();
		state.settings.cursor.show = keepCursor;
		settingsChanged({ rebind: true });
	});
	const aspect = $<HTMLSelectElement>("aspect");
	aspect.addEventListener("change", () => {
		S().aspect = aspect.value as Aspect;
		settingsChanged();
	});
	bindings.push({ sync: () => (aspect.value = S().aspect) });

	// Zoom panel
	const depth = $("zoom-depth");
	// The three visible depths (2/3/4 = 1.5×/1.8×/2.2×); storage still accepts Recordly's 1–6.
	for (const d of [2, 3, 4] as ZoomDepth[]) {
		const b = document.createElement("button");
		b.type = "button";
		b.setAttribute("role", "radio");
		b.dataset.value = String(d);
		b.textContent = `${ZOOM_DEPTH_SCALES[d]}×`;
		depth.append(b);
	}
	const sel = () => state.regions.find((r) => r.id === state.selectedId) ?? null;
	radios(depth, () => String(sel()?.depth ?? ""), (v) => {
		const r = sel();
		if (r) r.depth = Number(v) as ZoomDepth;
		regionsChanged();
	});
	radios($("zoom-mode"), () => sel()?.mode ?? "", (v) => {
		const r = sel();
		if (r) r.mode = v as "auto" | "manual";
		regionsChanged();
	});
	$("zoom-delete").addEventListener("click", deleteSelected);

	// Sidebar tabs (roving tabindex, arrow keys).
	const tabs = [...document.querySelectorAll<HTMLButtonElement>(".rail [role=tab]")];
	for (const t of tabs) {
		t.addEventListener("click", () => showSection(t.dataset.section!));
		t.addEventListener("keydown", (e) => {
			if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
			e.preventDefault();
			const i = tabs.indexOf(t);
			const n = tabs[(i + (e.key === "ArrowDown" ? 1 : tabs.length - 1)) % tabs.length];
			n.focus();
			n.click();
		});
	}

	syncControls();
	syncPickers();
	bindTransport();
	bindTimeline();
}

function showSection(id: string) {
	state.section = id;
	for (const t of document.querySelectorAll<HTMLButtonElement>(".rail [role=tab]")) {
		const on = t.dataset.section === id;
		t.setAttribute("aria-selected", String(on));
		t.tabIndex = on ? 0 : -1;
	}
	for (const p of document.querySelectorAll<HTMLElement>(".panel > section")) p.hidden = p.id !== `panel-${id}`;
	if (id !== "zoom") selectRegion(null, false);
}

// ------------------------------------------------------------------------------------------------
// Zoom regions + timeline

function saveProject() {
	if (state.projectId && !saveProjectZooms(state.projectId, state.durationMs, state.regions, undefined, state.trim, state.browserView)) {
		status("Edits could not be saved. Keep this tab open to avoid losing them.");
	}
}

function regionsChanged() {
	state.regions.sort((a, b) => a.startMs - b.startMs);
	saveProject();
	drawTimeline();
	syncZoomPanel();
	redraw();
}

function selectRegion(id: string | null, open = true) {
	state.selectedId = id;
	if (id && open && state.section !== "zoom") showSection("zoom");
	drawTimeline();
	syncZoomPanel();
}

function syncZoomPanel() {
	const r = state.regions.find((x) => x.id === state.selectedId) ?? null;
	$("zoom-none").hidden = !!r;
	$("zoom-edit").hidden = !r;
	canvas.classList.toggle("pick", r?.mode === "manual");
	syncControls();
}

function deleteSelected() {
	if (!state.selectedId) return;
	state.regions = state.regions.filter((r) => r.id !== state.selectedId);
	state.selectedId = null;
	regionsChanged();
}

function runSuggestions() {
	const sc = scene();
	state.regions = suggestZoomRegions(state.telemetry, state.durationMs, sc.videoW && sc.videoH ? sc.videoW / sc.videoH : 16 / 9, state.settings.zoom);
	state.selectedId = null;
	regionsChanged();
}

function addZoomAtPlayhead() {
	const t = Math.round(currentMs());
	const next = state.regions.find((r) => r.startMs > t);
	const inside = state.regions.find((r) => t >= r.startMs && t < r.endMs);
	if (inside) return selectRegion(inside.id);
	const end = Math.min(state.durationMs, next ? next.startMs : Number.POSITIVE_INFINITY, t + NEW_REGION_MS);
	if (end - t < MIN_REGION_MS) return status("No room for a zoom here");
	const r: ZoomRegion = { id: `zoom-${crypto.randomUUID()}`, startMs: t, endMs: end, depth: DEFAULT_ZOOM_DEPTH, focus: { cx: 0.5, cy: 0.5 }, mode: "auto" };
	state.regions.push(r);
	regionsChanged();
	selectRegion(r.id);
}

const pctOf = (ms: number) => `${(ms / (state.durationMs || 1)) * 100}%`;

function drawTimeline() {
	const d = state.durationMs || 1;
	const ruler = $("ruler");
	ruler.replaceChildren();
	const step = [1000, 2000, 5000, 10000, 30000, 60000].find((s) => d / s <= 12) ?? 120000;
	for (let t = 0; t <= d; t += step) {
		const s = document.createElement("span");
		s.style.left = pctOf(t);
		s.textContent = fmt(t).replace(/\.\d$/, "");
		ruler.append(s);
	}
	const clicks = $("clicks");
	clicks.replaceChildren();
	for (const p of state.telemetry) {
		if (p.interactionType === "move" || p.interactionType === "mouseup") continue;
		const i = document.createElement("i");
		i.style.left = pctOf(p.timeMs);
		clicks.append(i);
	}
	const track = $("zoom-track");
	track.replaceChildren();
	for (const r of state.regions) {
		const b = document.createElement("div");
		b.className = "zoom-block";
		b.dataset.id = r.id;
		b.setAttribute("role", "button");
		b.tabIndex = 0;
		b.setAttribute("aria-pressed", String(r.id === state.selectedId));
		b.setAttribute("aria-label", `Zoom ${ZOOM_DEPTH_SCALES[r.depth]}× ${r.mode ?? "auto"}, ${fmt(r.startMs)} to ${fmt(r.endMs)}`);
		b.style.left = pctOf(r.startMs);
		b.style.width = pctOf(r.endMs - r.startMs);
		b.innerHTML = `<span class="handle l"></span>${ZOOM_DEPTH_SCALES[r.depth]}×${r.mode === "manual" ? " · manual" : ""}<span class="handle r"></span>`;
		track.append(b);
	}
	const tl = $("timeline");
	tl.setAttribute("aria-valuemax", String(Math.round(d)));
	$("seg-count").textContent = `${state.regions.length} zoom${state.regions.length === 1 ? "" : "s"} · ${state.telemetry.filter((p) => p.interactionType && p.interactionType !== "move" && p.interactionType !== "mouseup").length} clicks`;
	syncTrimControls();
	updatePlayhead(currentMs());
}

function syncTrimControls() {
	const { startMs, endMs } = state.trim;
	$("trim-before").style.width = pctOf(startMs);
	$("trim-after").style.width = pctOf(Math.max(0, state.durationMs - endMs));
	$("trim-range").textContent = `${fmt(startMs)}–${fmt(endMs)} · ${fmt(endMs - startMs)} kept`;
	syncActions();
}

/** File/export actions and trim affordances follow loaded media and the export lock. */
function syncActions() {
	const hasMedia = !!state.screenBlob;
	for (const id of ["export-mp4", "export-webm"]) $<HTMLButtonElement>(id).disabled = !hasMedia || exporting;
	for (const id of ["add-zoom", "suggest-zooms"]) $<HTMLButtonElement>(id).disabled = !hasMedia;
	$<HTMLInputElement>("open-files").disabled = exporting;
	for (const id of ["trim-start", "trim-end"]) $<HTMLButtonElement>(id).disabled = !hasMedia;
	$<HTMLButtonElement>("trim-reset").disabled = !hasMedia || (state.trim.startMs === 0 && state.trim.endMs === state.durationMs);
}

function changeTrim(trim: TrimRange) {
	state.trim = trim;
	saveProject();
	syncTrimControls();
	if (currentMs() < trim.startMs || currentMs() > trim.endMs) seekTo(trim.startMs);
}

function updatePlayhead(t: number) {
	$("playhead").style.left = pctOf(t);
	const tl = $("timeline");
	tl.setAttribute("aria-valuenow", String(Math.round(t)));
	tl.setAttribute("aria-valuetext", fmt(t));
	$("time").textContent = `${fmt(t)} / ${fmt(state.durationMs)}`;
}

function seekTo(ms: number) {
	const t = Math.max(0, Math.min(state.durationMs, ms)) / 1000;
	comp.reset();
	screenVid.currentTime = t;
	if (hasCam()) camVid.currentTime = t;
	updatePlayhead(t * 1000);
}

function bindTimeline() {
	const tl = $("timeline");
	const msAt = (clientX: number) => {
		const r = $("zoom-track").getBoundingClientRect();
		return ((clientX - r.left) / r.width) * state.durationMs;
	};
	tl.addEventListener("pointerdown", (e) => {
		if (!state.durationMs) return;
		const block = (e.target as HTMLElement).closest<HTMLElement>(".zoom-block");
		tl.setPointerCapture(e.pointerId);
		if (block) {
			const r = state.regions.find((x) => x.id === block.dataset.id)!;
			selectRegion(r.id);
			const handle = (e.target as HTMLElement).closest(".handle");
			const mode = handle?.classList.contains("l") ? "l" : handle?.classList.contains("r") ? "r" : "move";
			const start = { x: msAt(e.clientX), s: r.startMs, e: r.endMs };
			const i = state.regions.indexOf(r);
			const lo = i > 0 ? state.regions[i - 1].endMs : 0;
			const hi = i < state.regions.length - 1 ? state.regions[i + 1].startMs : state.durationMs;
			const move = (ev: PointerEvent) => {
				const dx = msAt(ev.clientX) - start.x;
				if (mode === "l") r.startMs = Math.round(Math.max(lo, Math.min(start.e - MIN_REGION_MS, start.s + dx)));
				else if (mode === "r") r.endMs = Math.round(Math.min(hi, Math.max(start.s + MIN_REGION_MS, start.e + dx)));
				else {
					const len = start.e - start.s;
					r.startMs = Math.round(Math.max(lo, Math.min(hi - len, start.s + dx)));
					r.endMs = r.startMs + len;
				}
				drawTimeline();
			};
			const up = () => {
				tl.removeEventListener("pointermove", move);
				regionsChanged();
			};
			tl.addEventListener("pointermove", move);
			tl.addEventListener("pointerup", up, { once: true });
			return;
		}
		seekTo(msAt(e.clientX));
		const move = (ev: PointerEvent) => seekTo(msAt(ev.clientX));
		tl.addEventListener("pointermove", move);
		tl.addEventListener("pointerup", () => tl.removeEventListener("pointermove", move), { once: true });
	});
	tl.addEventListener("keydown", (e) => {
		const block = (e.target as HTMLElement).closest<HTMLElement>(".zoom-block");
		if (block && (e.key === "Enter" || e.key === " ")) {
			e.preventDefault();
			selectRegion(block.dataset.id!);
			return;
		}
		if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
			e.preventDefault();
			seekTo(currentMs() + (e.key === "ArrowLeft" ? -1 : 1) * (e.shiftKey ? 5000 : 1000));
		}
	});
	$("add-zoom").addEventListener("click", addZoomAtPlayhead);
	$("suggest-zooms").addEventListener("click", runSuggestions);
	$("trim-start").addEventListener("click", () => changeTrim(setTrimEdge(state.trim, "start", currentMs(), state.durationMs)));
	$("trim-end").addEventListener("click", () => changeTrim(setTrimEdge(state.trim, "end", currentMs(), state.durationMs)));
	$("trim-reset").addEventListener("click", () => changeTrim(fullTrim(state.durationMs)));
	// Manual focus: click the preview while a manual zoom is selected (inverse of the camera transform).
	canvas.addEventListener("click", (e) => {
		const r = state.regions.find((x) => x.id === state.selectedId);
		if (!r || r.mode !== "manual") return;
		const box = canvas.getBoundingClientRect();
		const px = ((e.clientX - box.left) / box.width) * canvas.width;
		const py = ((e.clientY - box.top) / box.height) * canvas.height;
		const cam = comp.lastCamera;
		const lx = (px - cam.x) / cam.scale;
		const ly = (py - cam.y) / cam.scale;
		const sc = scene();
		const { mask } = computeFrameLayout(canvas.width, canvas.height, sc.videoW || 16, sc.videoH || 9, state.settings.frame, sc.crop);
		const clamp01 = (v: number) => Math.max(0, Math.min(1, v));
		// Persist original-source focus, so toggling the crop cannot drift a manual zoom.
		r.focus = { cx: sc.crop.x + clamp01((lx - mask.x) / mask.width) * sc.crop.width,
			cy: sc.crop.y + clamp01((ly - mask.y) / mask.height) * sc.crop.height };
		regionsChanged();
	});
}

function bindTransport() {
	const play = $<HTMLButtonElement>("play");
	const toggle = () => {
		if (!state.screenBlob) return;
		if (screenVid.paused) {
			if (screenVid.ended || currentMs() < state.trim.startMs || currentMs() >= state.trim.endMs - 30) seekTo(state.trim.startMs);
			void screenVid.play();
			if (hasCam()) void camVid.play();
			requestAnimationFrame(loop);
		} else {
			screenVid.pause();
			camVid.pause();
		}
	};
	play.addEventListener("click", toggle);
	screenVid.addEventListener("play", () => {
		play.textContent = "❚❚";
		play.setAttribute("aria-label", "Pause");
		play.setAttribute("aria-pressed", "true");
	});
	screenVid.addEventListener("pause", () => {
		play.textContent = "▶";
		play.setAttribute("aria-label", "Play");
		play.setAttribute("aria-pressed", "false");
	});
	screenVid.addEventListener("seeked", redraw);
	camVid.addEventListener("seeked", redraw);
	camVid.addEventListener("loadeddata", redraw);
	document.addEventListener("keydown", (e) => {
		const t = e.target as HTMLElement;
		// Typing and widget keys keep their native behaviour: sliders, selects, checkboxes, radio
		// groups and the timeline must not lose Space or the arrows to transport shortcuts.
		if (t instanceof HTMLInputElement || t instanceof HTMLSelectElement || t instanceof HTMLTextAreaElement || t.isContentEditable) return;
		const widget = !!t.closest('[role="radiogroup"], [role="radio"], [role="tablist"], #timeline');
		if (e.code === "Space" && !widget) {
			e.preventDefault();
			if (t instanceof HTMLButtonElement) t.blur();
			toggle();
		} else if (!widget && (e.key === "ArrowLeft" || e.key === "ArrowRight")) {
			if (!state.screenBlob) return;
			e.preventDefault();
			seekTo(currentMs() + (e.key === "ArrowLeft" ? -1 : 1) * (e.shiftKey ? 5000 : 1000));
		} else if ((e.key === "z" || e.key === "Z") && !e.ctrlKey && !e.metaKey && !e.altKey) {
			if (!state.screenBlob) return;
			e.preventDefault();
			addZoomAtPlayhead();
		} else if ((e.key === "Delete" || e.key === "Backspace") && state.selectedId) {
			e.preventDefault();
			deleteSelected();
		} else if (e.key === "Escape") selectRegion(null, false);
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

	// Export runs entirely in this page (WebCodecs + Mediabunny); it never talks to the extension's
	// service worker, so Chrome stopping an idle MV3 worker can't interrupt it.
	let ctrl: AbortController | null = null;
	const doExport = async (container: "mp4" | "webm") => {
		if (!state.screenBlob || ctrl) return;
		ctrl = new AbortController();
		exporting = true;
		syncActions();
		const active = $<HTMLButtonElement>(`export-${container}`);
		const label = active.textContent;
		active.textContent = "Exporting…";
		const prog = $<HTMLProgressElement>("progress");
		prog.hidden = false;
		prog.value = 0;
		$("cancel").hidden = false;
		const t0 = performance.now();
		try {
			const res = await runExport(container, (p) => {
				prog.value = p;
				active.textContent = `Exporting… ${Math.round(p * 100)}%`;
				status(`Exporting ${container.toUpperCase()}… ${Math.round(p * 100)}%`);
			}, ctrl.signal);
			const a = document.createElement("a");
			a.href = URL.createObjectURL(res.blob);
			a.download = `glide-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-")}.${container}`;
			a.click();
			status(`Exported ${res.width}×${res.height} ${container.toUpperCase()} (${res.videoCodec}${res.audioCodec ? ` + ${res.audioCodec}` : ""}, ${(res.blob.size / 1e6).toFixed(1)} MB) in ${((performance.now() - t0) / 1000).toFixed(1)}s`);
		} catch (err) {
			status((err as Error).name === "AbortError" ? "Export cancelled" : `Export failed: ${(err as Error).message}`);
		} finally {
			ctrl = null;
			exporting = false;
			active.textContent = label;
			prog.hidden = true;
			$("cancel").hidden = true;
			syncActions();
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
		bgImage: state.settings.frame.background.kind === "image" ? state.bgImage : null,
		scene: structuredClone(scene()),
		settings: structuredClone(state.settings),
		durationMs: state.durationMs,
		trim: structuredClone(state.trim),
		onProgress,
		signal,
	});
}

// ------------------------------------------------------------------------------------------------
// Loading

let loadGeneration = 0;
let screenUrl = "";
let camUrl = "";
async function loadBundle(meta: RecordingMeta, screen: Blob, cam: Blob | null, events: PointerEvt[], projectId: string | null = null) {
	const generation = ++loadGeneration;
	delete document.body.dataset.ready;
	screenVid.pause();
	camVid.pause();
	// Detach the old project BEFORE an asynchronous import, so imports can't overwrite it.
	state.projectId = null;
	state.selectedId = null;
	state.regions = [];
	status("Preparing recording…");
	const s = await makeSeekable(screen);
	const c = cam ? await makeSeekable(cam) : null;
	if (generation !== loadGeneration) return;
	state.meta = meta;
	state.screenBlob = s.blob;
	state.camBlob = c?.blob ?? null;
	state.events = events;
	state.durationMs = s.durationMs || meta.durationMs;
	state.trim = (projectId ? loadProjectTrim(projectId, state.durationMs) : null) ?? fullTrim(state.durationMs);
	state.browserView = projectId ? loadProjectBrowserView(projectId, state.durationMs) : normalizeBrowserView(null);
	const surface: Surface = meta.surface ?? "browser";
	state.telemetry = toTelemetry(events, surface, state.durationMs);
	// Tab capture has no OS cursor baked in; window/screen capture usually does.
	if (!localStorage.getItem("glide.cursorTouched")) state.settings.cursor.show = surface === "browser";
	const loaded = new Promise((r) => screenVid.addEventListener("loadeddata", r, { once: true }));
	if (screenUrl) URL.revokeObjectURL(screenUrl);
	if (camUrl) URL.revokeObjectURL(camUrl);
	screenVid.src = screenUrl = URL.createObjectURL(s.blob);
	camUrl = c ? URL.createObjectURL(c.blob) : "";
	if (camUrl) camVid.src = camUrl;
	else {
		camVid.removeAttribute("src");
		camVid.load();
	}
	await loaded;
	if (generation !== loadGeneration) return;
	// Like Recordly, restore a project before considering fresh-recording suggestions.
	const savedZooms = projectId ? loadProjectZooms(projectId, state.durationMs) : null;
	if (savedZooms !== null) state.regions = savedZooms;
	state.projectId = projectId;
	if (savedZooms === null && state.settings.autoApplyZooms) runSuggestions();
	else regionsChanged();
	settingsChanged({ rebind: true });
	await preloadCursorAssets().catch(() => {});
	if (generation !== loadGeneration) return;
	comp.reset();
	draw(true);
	const clicks = state.telemetry.filter((p) => p.interactionType !== "move" && p.interactionType !== "mouseup").length;
	status(`${surface} capture · ${screenVid.videoWidth}×${screenVid.videoHeight} · ${fmt(state.durationMs)} · ${clicks} clicks → ${state.regions.length} zooms`);
	document.body.dataset.ready = "1";
	syncActions();
}

async function init() {
	bindControls();
	syncActions();
	ensureBackgroundImage();
	const p = new URLSearchParams(location.search);
	const id = p.get("id");
	try {
		if (id) {
			const b = await loadRecording(id);
			if (!b) throw new Error(`Recording ${id} not found`);
			await loadBundle(b.meta, b.screen, b.camera, b.events, id);
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
			drawTimeline();
			syncZoomPanel();
			draw(true);
			status("Open files to start");
		}
	} catch (e) {
		const message = String(e);
		status(message);
		showEmptyState(`${message}. It was deleted or isn't on this device — import a video with Open files, or record again from the Glide toolbar button.`);
		draw(true);
		syncActions();
	}
}

/** Visible recovery card. Text only: ids can come from the URL. */
function showEmptyState(message: string) {
	const empty = $("empty");
	empty.hidden = false;
	empty.setAttribute("role", "alert");
	empty.querySelector("p")!.textContent = message;
}

// Test hook (used by test/e2e.mjs).
(window as unknown as { glide: object }).glide = {
	state,
	camera: () => comp.lastCamera,
	crop: () => scene().crop,
	selectRegion: (id: string | null) => selectRegion(id),
	seek: async (ms: number) => {
		const vids = hasCam() ? [screenVid, camVid] : [screenVid];
		comp.reset();
		await Promise.all(
			vids.map(
				(v) =>
					new Promise<void>((r) => {
						v.addEventListener("seeked", () => r(), { once: true });
						v.currentTime = ms / 1000;
					}),
			),
		);
		draw(true);
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
