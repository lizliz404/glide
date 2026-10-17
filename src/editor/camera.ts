// Virtual camera: decides where to zoom and how the zoom moves.
// Policy (when/where to zoom) is ours; the motion is OpenScreen's (vendored, MIT):
// - cursor follow: advanceFollowFocus + AUTO_FOLLOW_PARAMS (frame-rate independent)
// - camera motion: stepZoomSpring (per-axis spring with overshoot clamp)
// - cursor smoothing: stepSpringValue + getCursorSpringConfig
import { AUTO_FOLLOW_PARAMS } from "../vendor/openscreen/constants";
import { advanceFollowFocus, interpolateCursorAt } from "../vendor/openscreen/cursorFollowUtils";
import { createSpringState, getCursorSpringConfig, stepSpringValue, type SpringState } from "../vendor/openscreen/motionSmoothing";
import type { CursorTelemetryPoint, ZoomFocus } from "../vendor/openscreen/types";
import { createZoomSpringState, resetZoomSpring, stepZoomSpring, type ZoomSpringState, type ZoomTransform } from "../vendor/openscreen/zoomSpring";
import type { PointerEvt, Surface } from "../shared/types";
import type { Settings } from "./settings";

export interface ZoomSegment {
	start: number;
	end: number;
	clicks: number[];
}

export interface Track {
	telemetry: CursorTelemetryPoint[];
	clicks: { t: number; x: number; y: number }[];
	cursorStyle: { t: number; c: PointerEvt["cursor"] }[];
}

export function buildTrack(events: PointerEvt[], surface: Surface): Track {
	const key = surface === "browser" ? "tab" : surface === "window" ? "win" : "mon";
	const sorted = [...events].sort((a, b) => a.t - b.t);
	const inside = (p: [number, number]) => p[0] >= -0.02 && p[0] <= 1.02 && p[1] >= -0.02 && p[1] <= 1.02;
	const telemetry: CursorTelemetryPoint[] = [];
	const clicks: Track["clicks"] = [];
	const cursorStyle: Track["cursorStyle"] = [];
	for (const e of sorted) {
		const p = e[key];
		if (!p || !inside(p)) continue;
		telemetry.push({ timeMs: e.t, cx: p[0], cy: p[1], interactionType: e.kind === "down" ? "click" : e.kind === "up" ? "mouseup" : "move" });
		if (e.kind === "down") clicks.push({ t: e.t, x: p[0], y: p[1] });
		cursorStyle.push({ t: e.t, c: e.cursor });
	}
	return { telemetry, clicks, cursorStyle };
}

/** Group clicks into zoom windows: clicks closer than gapMs share one zoom. */
export function buildSegments(track: Track, z: Settings["zoom"], durationMs: number): ZoomSegment[] {
	const groups: number[][] = [];
	for (const c of track.clicks) {
		const g = groups[groups.length - 1];
		if (g && c.t - g[g.length - 1] <= z.gapMs) g.push(c.t);
		else groups.push([c.t]);
	}
	const segs: ZoomSegment[] = [];
	for (const g of groups) {
		if (g.length < z.minClicks) continue;
		const seg = { start: Math.max(0, g[0] - z.leadMs), end: Math.min(durationMs, g[g.length - 1] + z.holdMs), clicks: g };
		const prev = segs[segs.length - 1];
		if (prev && seg.start - prev.end < 800) {
			prev.end = seg.end;
			prev.clicks.push(...seg.clicks);
		} else segs.push(seg);
	}
	return segs;
}

export interface CameraFrame {
	/** Visible window of the source, normalised (x,y = top-left). */
	view: { x: number; y: number; w: number; h: number };
	scale: number;
	cursor: (ZoomFocus & { style: PointerEvt["cursor"]; pressed: boolean }) | null;
}

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

export class Camera {
	private zoom: ZoomSpringState = createZoomSpringState();
	private focus: ZoomFocus = { cx: 0.5, cy: 0.5 };
	private cursorX: SpringState = createSpringState(0.5);
	private cursorY: SpringState = createSpringState(0.5);
	private lastSeg: ZoomSegment | null = null;
	private lastT = -1;

	constructor(
		private track: Track,
		private segments: ZoomSegment[],
		private settings: Settings,
	) {}

	update(track: Track, segments: ZoomSegment[], settings: Settings) {
		this.track = track;
		this.segments = segments;
		this.settings = settings;
	}

	private segmentAt(t: number) {
		return this.settings.zoom.enabled ? (this.segments.find((s) => t >= s.start && t <= s.end) ?? null) : null;
	}

	private target(t: number, dtMs: number, snap: boolean): ZoomTransform {
		const seg = this.segmentAt(t);
		const raw = interpolateCursorAt(this.track.telemetry, t);
		if (!seg) {
			this.lastSeg = null;
			this.focus = { cx: 0.5, cy: 0.5 };
			return { scale: 1, x: 0.5, y: 0.5 };
		}
		const scale = this.settings.zoom.scale;
		if (seg !== this.lastSeg || snap) {
			// Entering a zoom: aim at the first click of the group (or cursor if following).
			const first = this.track.clicks.find((c) => c.t >= seg.start) ?? null;
			this.focus = first ? { cx: first.x, cy: first.y } : (raw ?? { cx: 0.5, cy: 0.5 });
			this.lastSeg = seg;
		} else if (this.settings.zoom.follow && raw) {
			this.focus = advanceFollowFocus(this.focus, raw, dtMs, AUTO_FOLLOW_PARAMS);
		} else if (!this.settings.zoom.follow) {
			const last = [...this.track.clicks].reverse().find((c) => c.t <= t && c.t >= seg.start);
			if (last) this.focus = { cx: last.x, cy: last.y };
		}
		const half = 0.5 / scale;
		return { scale, x: clamp(this.focus.cx, half, 1 - half), y: clamp(this.focus.cy, half, 1 - half) };
	}

	/** Advance to time t (ms). Large jumps (seek) snap instead of animating. */
	frame(t: number, dtMs: number): CameraFrame {
		const snap = this.lastT < 0 || t < this.lastT || t - this.lastT > 300;
		this.lastT = t;
		const target = this.target(t, dtMs, snap);
		let z: ZoomTransform;
		if (snap) {
			resetZoomSpring(this.zoom, target);
			z = target;
		} else z = stepZoomSpring(this.zoom, target, dtMs);

		const scale = Math.max(1, z.scale);
		const w = 1 / scale;
		const view = { x: clamp(z.x - w / 2, 0, 1 - w), y: clamp(z.y - w / 2, 0, 1 - w), w, h: w };

		let cursor: CameraFrame["cursor"] = null;
		const raw = interpolateCursorAt(this.track.telemetry, t);
		if (raw && this.track.telemetry.length && t >= this.track.telemetry[0].timeMs) {
			const cfg = getCursorSpringConfig(this.settings.cursor.smoothing);
			if (snap) {
				this.cursorX = createSpringState(raw.cx);
				this.cursorY = createSpringState(raw.cy);
			}
			const cx = stepSpringValue(this.cursorX, raw.cx, dtMs, cfg);
			const cy = stepSpringValue(this.cursorY, raw.cy, dtMs, cfg);
			const st = lastBefore(this.track.cursorStyle, t)?.c ?? "arrow";
			const pressed = this.track.telemetry.some((p) => p.interactionType === "click" && t - p.timeMs >= 0 && t - p.timeMs < 140);
			cursor = { cx, cy, style: st, pressed };
		}
		return { view, scale, cursor };
	}
}

function lastBefore<T extends { t: number }>(arr: T[], t: number): T | undefined {
	let lo = 0;
	let hi = arr.length - 1;
	let best: T | undefined;
	while (lo <= hi) {
		const mid = (lo + hi) >> 1;
		if (arr[mid].t <= t) {
			best = arr[mid];
			lo = mid + 1;
		} else hi = mid - 1;
	}
	return best;
}
