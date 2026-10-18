// Browser counterpart of Recordly's projectPersistence: keep explicit timeline edits separate
// from global preferences. Only extension recordings have stable identity; raw file imports and
// dev URLs deliberately don't share a project. No recording blobs or database schema changes.
import type { ZoomRegion } from "../vendor/recordly/types";
import { validTrim, type TrimRange } from "./trim";
import { normalizeBrowserView, type BrowserView } from "./browserView";

type ProjectStorage = Pick<Storage, "getItem" | "setItem">;
const key = (id: string) => `glide.project.v1.${encodeURIComponent(id)}`;

/** null = fresh/invalid project; [] = deliberately removed all zooms. Never conflate the two. */
export function loadProjectZooms(id: string, durationMs: number, storage?: ProjectStorage): ZoomRegion[] | null {
	try {
		const raw = (storage ?? globalThis.localStorage).getItem(key(id));
		if (!raw) return null;
		const p = JSON.parse(raw);
		if (p?.version !== 1 || !Number.isFinite(p.durationMs) || Math.abs(p.durationMs - durationMs) > 1 || !Array.isArray(p.regions)) return null;
		const ids = new Set<string>();
		for (const r of p.regions) {
			if (!r || typeof r.id !== "string" || !r.id || ids.has(r.id)
				|| !Number.isFinite(r.startMs) || !Number.isFinite(r.endMs)
				|| r.startMs < 0 || r.endMs <= r.startMs || r.endMs > durationMs
				|| ![1, 2, 3, 4, 5, 6].includes(r.depth)
				|| !r.focus || !Number.isFinite(r.focus.cx) || !Number.isFinite(r.focus.cy)
				|| r.focus.cx < 0 || r.focus.cx > 1 || r.focus.cy < 0 || r.focus.cy > 1
				|| (r.mode !== undefined && r.mode !== "auto" && r.mode !== "manual")) return null;
			ids.add(r.id);
		}
		return p.regions;
	} catch {
		return null;
	}
}

/** Synchronous small JSON writes survive immediate reload; quota/blocked storage is reported. */
export function saveProjectZooms(id: string, durationMs: number, regions: ZoomRegion[], storage?: ProjectStorage, trim?: TrimRange, browserView?: BrowserView): boolean {
	try {
		(storage ?? globalThis.localStorage).setItem(key(id), JSON.stringify({ version: 1, durationMs, regions, trim, browserView }));
		return true;
	} catch {
		return false;
	}
}

/** Per-recording presentation choice, never a global crop applied to unrelated recordings. */
export function loadProjectBrowserView(id: string, durationMs: number, storage?: ProjectStorage): BrowserView {
	try {
		const raw = (storage ?? globalThis.localStorage).getItem(key(id));
		const p = raw ? JSON.parse(raw) : null;
		if (p?.version === 1 && Number.isFinite(p.durationMs) && Math.abs(p.durationMs - durationMs) <= 1) {
			return normalizeBrowserView(p.browserView);
		}
	} catch { /* Invalid or unavailable storage opens the uncropped source. */ }
	return normalizeBrowserView(null);
}

/** Additive field: existing v1 zoom-only projects still open with the full range. */
export function loadProjectTrim(id: string, durationMs: number, storage?: ProjectStorage): TrimRange | null {
	try {
		const raw = (storage ?? globalThis.localStorage).getItem(key(id));
		if (!raw) return null;
		const p = JSON.parse(raw);
		if (p?.version !== 1 || !Number.isFinite(p.durationMs) || Math.abs(p.durationMs - durationMs) > 1) return null;
		return validTrim(p.trim, durationMs) ? p.trim : null;
	} catch {
		return null;
	}
}
