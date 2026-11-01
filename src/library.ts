import { deleteRecording, listRecordings, loadRecording } from "./shared/db";
import type { RecordingMeta, Surface } from "./shared/types";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const list = $<HTMLUListElement>("list");
const statusEl = $<HTMLElement>("status");

const SURFACE_LABEL: Record<Surface, string> = { browser: "Tab", window: "Window", monitor: "Screen" };

function fmtDuration(ms: number) {
	const s = Math.max(0, Math.round(ms / 1000));
	return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

function fmtSize(bytes: number) {
	if (bytes < 1024) return `${bytes} B`;
	const units = ["KB", "MB", "GB"];
	let v = bytes / 1024;
	let i = 0;
	while (v >= 1024 && i < units.length - 1) {
		v /= 1024;
		i++;
	}
	return `${v.toFixed(v >= 100 ? 0 : 1)} ${units[i]}`;
}

function downloadName(m: RecordingMeta) {
	const d = new Date(m.createdAt);
	const p = (n: number) => String(n).padStart(2, "0");
	return `glide-${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}.webm`;
}

// The screen blob backs both the thumbnail and the Download button; keep one object
// URL per row and revoke it when the row goes away.
function fillMedia(row: HTMLLIElement, m: RecordingMeta) {
	const sizeEl = row.querySelector<HTMLElement>(".lib-size");
	const thumb = row.querySelector<HTMLElement>(".lib-thumb");
	void loadRecording(m.id).then((b) => {
		if (!b || !row.isConnected) return;
		if (sizeEl) sizeEl.textContent = fmtSize(b.screen.size + (b.camera?.size ?? 0));
		const url = URL.createObjectURL(b.screen);
		row.dataset.url = url;
		const v = document.createElement("video");
		v.muted = true;
		v.playsInline = true;
		v.preload = "metadata";
		v.src = url;
		v.addEventListener("loadedmetadata", () => {
			v.currentTime = Math.min(m.headTrimMs ? m.headTrimMs / 1000 + 0.3 : 1, v.duration * 0.9 || 0);
		});
		v.addEventListener("error", () => {
			v.remove();
		});
		if (thumb) {
			thumb.textContent = "";
			thumb.append(v);
		}
		const dl = row.querySelector<HTMLButtonElement>(".lib-download");
		dl?.addEventListener("click", () => {
			const a = document.createElement("a");
			a.href = url;
			a.download = downloadName(m);
			a.click();
		});
	});
}

function row(m: RecordingMeta) {
	const li = document.createElement("li");
	li.className = "lib-row";

	const thumb = document.createElement("a");
	thumb.className = "lib-thumb";
	thumb.href = `editor.html?id=${encodeURIComponent(m.id)}`;
	thumb.title = "Open in the editor";
	thumb.textContent = "…";

	const info = document.createElement("div");
	info.className = "lib-info";
	const title = document.createElement("span");
	title.className = "lib-title";
	title.textContent = `${SURFACE_LABEL[m.surface] ?? m.surface} · ${new Date(m.createdAt).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })}`;
	const sub = document.createElement("span");
	sub.className = "lib-sub hint";
	const dur = document.createElement("span");
	dur.className = "mono";
	dur.textContent = fmtDuration(m.durationMs);
	const size = document.createElement("span");
	size.className = "lib-size mono";
	size.textContent = "…";
	const badges = [m.width && m.height ? `${m.width}×${m.height}` : "", m.hasCamera ? "cam" : "", m.hasMic ? "mic" : ""].filter(Boolean).join(" · ");
	sub.append(dur, " · ", size, badges ? ` · ${badges}` : "");
	info.append(title, sub);

	const actions = document.createElement("div");
	actions.className = "lib-actions";
	const edit = document.createElement("a");
	edit.className = "btn small";
	edit.href = `editor.html?id=${encodeURIComponent(m.id)}`;
	edit.textContent = "Edit";
	const dl = document.createElement("button");
	dl.type = "button";
	dl.className = "btn small ghost lib-download";
	dl.textContent = "Download";
	const del = document.createElement("button");
	del.type = "button";
	del.className = "btn small ghost lib-delete";
	del.textContent = "Delete";
	del.addEventListener("click", async () => {
		if (!confirm("Delete this recording? This cannot be undone.")) return;
		del.disabled = true;
		try {
			await deleteRecording(m.id);
			if (li.dataset.url) URL.revokeObjectURL(li.dataset.url);
			li.remove();
			setCount(list.childElementCount);
		} catch {
			del.disabled = false;
			statusEl.textContent = "Could not delete — try again.";
		}
	});
	actions.append(edit, dl, del);

	li.append(thumb, info, actions);
	fillMedia(li, m);
	return li;
}

function setCount(n: number) {
	statusEl.textContent = n ? `${n} recording${n === 1 ? "" : "s"}` : "";
	$("empty").hidden = n > 0;
}

async function refresh() {
	for (const li of list.querySelectorAll<HTMLLIElement>(".lib-row")) {
		if (li.dataset.url) URL.revokeObjectURL(li.dataset.url);
	}
	list.textContent = "";
	statusEl.textContent = "Loading…";
	try {
		const metas = await listRecordings();
		for (const m of metas) list.append(row(m));
		setCount(metas.length);
	} catch {
		statusEl.textContent = "Could not read the recording store.";
	}
}

$("refresh").addEventListener("click", () => void refresh());
void refresh();
