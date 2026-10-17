import type { RecordingBundle, RecordingMeta } from "./types";

// Tiny IndexedDB wrapper. Recordings are stored as Blobs in the extension origin so the
// offscreen recorder and the editor tab (same origin) can hand off large media without
// pushing it through runtime messaging (which JSON-serialises and caps message size).
const DB = "glide";
const STORE = "recordings";

function open(): Promise<IDBDatabase> {
	return new Promise((resolve, reject) => {
		const req = indexedDB.open(DB, 1);
		req.onupgradeneeded = () => req.result.createObjectStore(STORE, { keyPath: "meta.id" });
		req.onsuccess = () => resolve(req.result);
		req.onerror = () => reject(req.error);
	});
}

function tx<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
	return open().then(
		(db) =>
			new Promise<T>((resolve, reject) => {
				const t = db.transaction(STORE, mode);
				const req = fn(t.objectStore(STORE));
				t.oncomplete = () => resolve(req.result);
				t.onerror = () => reject(t.error);
			}),
	);
}

export const saveRecording = (b: RecordingBundle) => tx("readwrite", (s) => s.put(b)).then(() => b.meta.id);
export const loadRecording = (id: string) => tx<RecordingBundle | undefined>("readonly", (s) => s.get(id));
export const deleteRecording = (id: string) => tx("readwrite", (s) => s.delete(id));
export async function listRecordings(): Promise<RecordingMeta[]> {
	const all = await tx<RecordingBundle[]>("readonly", (s) => s.getAll());
	return all.map((b) => b.meta).sort((a, b) => b.createdAt - a.createdAt);
}
