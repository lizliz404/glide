import type { RecordingBundle, RecordingMeta } from "./types";

// Tiny IndexedDB wrapper. Recordings are stored as Blobs in the extension origin so the
// offscreen recorder and the editor tab (same origin) can hand off large media without
// pushing it through runtime messaging (which JSON-serialises and caps message size).
const DB = "glide";
const STORE = "recordings";
/** Live MediaRecorder chunks, written as they arrive so a crash or closed recorder keeps the take. */
const CHUNKS = "chunks";

function open(): Promise<IDBDatabase> {
	return new Promise((resolve, reject) => {
		const req = indexedDB.open(DB, 2);
		req.onupgradeneeded = () => {
			const names = req.result.objectStoreNames;
			if (!names.contains(STORE)) req.result.createObjectStore(STORE, { keyPath: "meta.id" });
			if (!names.contains(CHUNKS)) req.result.createObjectStore(CHUNKS, { autoIncrement: true }).createIndex("rec", "rec");
		};
		req.onsuccess = () => resolve(req.result);
		req.onerror = () => reject(req.error);
	});
}

function tx<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>, store = STORE): Promise<T> {
	return open().then(
		(db) =>
			new Promise<T>((resolve, reject) => {
				const t = db.transaction(store, mode);
				const req = fn(t.objectStore(store));
				t.oncomplete = () => {
					db.close();
					resolve(req.result);
				};
				t.onerror = () => reject(t.error);
			}),
	);
}

/** One chunk row. `meta` is the in-progress take's metadata, refreshed with every chunk. */
interface ChunkRow {
	rec: string;
	kind: "screen" | "camera";
	data: Blob;
	meta: RecordingMeta;
}

export const appendChunk = (row: ChunkRow) => tx("readwrite", (s) => s.add(row), CHUNKS);

/** Assemble a take from its stored chunks into a recording, then drop the chunks. */
export async function finishChunks(rec: string, events: RecordingBundle["events"], meta?: RecordingMeta) {
	const rows = await tx<ChunkRow[]>("readonly", (s) => s.index("rec").getAll(rec), CHUNKS);
	if (!rows.length) return null;
	const pick = (k: ChunkRow["kind"]) => rows.filter((r) => r.kind === k).map((r) => r.data);
	const camera = pick("camera");
	const m = meta ?? rows[rows.length - 1].meta;
	await saveRecording({
		meta: { ...m, hasCamera: camera.length > 0 },
		screen: new Blob(pick("screen"), { type: "video/webm" }),
		camera: camera.length ? new Blob(camera, { type: "video/webm" }) : null,
		events,
	});
	const keys = await tx<IDBValidKey[]>("readonly", (s) => s.index("rec").getAllKeys(rec), CHUNKS);
	for (const k of keys) await tx("readwrite", (s) => s.delete(k), CHUNKS);
	return m.id;
}

/** Takes whose recorder died before stop (crash, closed tab, evicted document). Saved without pointer data. */
export async function recoverOrphans() {
	const db = await open();
	const ids = await new Promise<string[]>((resolve, reject) => {
		const out: string[] = [];
		const req = db.transaction(CHUNKS).objectStore(CHUNKS).index("rec").openKeyCursor(null, "nextunique");
		req.onsuccess = () => {
			const c = req.result;
			if (!c) return resolve(out);
			out.push(c.key as string);
			c.continue();
		};
		req.onerror = () => reject(req.error);
	});
	db.close();
	const saved: string[] = [];
	for (const id of ids) {
		const out = await finishChunks(id, []);
		if (out) saved.push(out);
	}
	return saved;
}

export const saveRecording = (b: RecordingBundle) => tx("readwrite", (s) => s.put(b)).then(() => b.meta.id);
export const loadRecording = (id: string) => tx<RecordingBundle | undefined>("readonly", (s) => s.get(id));
export const deleteRecording = (id: string) => tx("readwrite", (s) => s.delete(id));
export async function listRecordings(): Promise<RecordingMeta[]> {
	const all = await tx<RecordingBundle[]>("readonly", (s) => s.getAll());
	return all.map((b) => b.meta).sort((a, b) => b.createdAt - a.createdAt);
}
