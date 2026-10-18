// Real extension-origin regression: user zoom edits survive immediate reload, including [];
// recordings are isolated and raw/dev imports never inherit another recording's project.
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import puppeteer from "puppeteer-core";

const root = resolve(".");
// P2-8: no hard-coded distro path — CHROME first, then whatever Chrome/Chromium is installed.
const CHROME_PATHS = ["/usr/bin/google-chrome", "/usr/bin/google-chrome-stable", "/usr/bin/chromium", "/usr/bin/chromium-browser"];
const chrome = process.env.CHROME ?? CHROME_PATHS.find((p) => existsSync(p));
if (!chrome) throw new Error(`No Chrome/Chromium found; set CHROME=<path>. Tried: ${CHROME_PATHS.join(", ")}`);
const browser = await puppeteer.launch({
	executablePath: chrome,
	headless: true,
	enableExtensions: true,
	pipe: true,
	args: ["--no-sandbox"],
});
try {
	const id = await browser.installExtension(`${root}/dist`);
	const base = `chrome-extension://${id}/editor.html`;
	const page = await browser.newPage();
	page.on("pageerror", (e) => { throw e; });
	await page.goto(base);
	await page.waitForFunction(() => !!window.glide);
	const bytes = (await readFile("test/fixtures/screen.webm")).toString("base64");
	const fixture = JSON.parse(await readFile("test/fixtures/events.json", "utf8"));
	await page.evaluate(async ({ bytes, fixture }) => {
		const screen = new Blob([Uint8Array.from(atob(bytes), (c) => c.charCodeAt(0))], { type: "video/webm" });
		const db = await new Promise((resolve, reject) => {
			const req = indexedDB.open("glide", 1);
			req.onupgradeneeded = () => req.result.createObjectStore("recordings", { keyPath: "meta.id" });
			req.onsuccess = () => resolve(req.result);
			req.onerror = () => reject(req.error);
		});
		await new Promise((resolve, reject) => {
			const tx = db.transaction("recordings", "readwrite");
			for (const id of ["persist-a", "persist-b", "persist-w"]) tx.objectStore("recordings").put({
				meta: { ...fixture.meta, id, createdAt: Date.now(), startedAt: 0, durationMs: 12000, ...(id === "persist-w" ? { surface: "window" } : {}) },
				screen, camera: null, events: fixture.events,
			});
			tx.oncomplete = resolve;
			tx.onerror = () => reject(tx.error);
		});
		db.close();
	}, { bytes, fixture });
	const ready = () => page.waitForSelector("body[data-ready]", { timeout: 30000 });
	const regions = () => page.evaluate(() => structuredClone(glide.state.regions));
	const removeAll = async () => {
		for (let n = (await regions()).length; n > 0; n--) {
			await page.click(".zoom-block");
			await page.click("#zoom-delete");
		}
	};
	await page.goto(`${base}?id=persist-a`);
	await ready();
	assert.equal((await regions()).length, 3, "fresh recordings get suggestions");
	// Look / Motion rail with presets; the raw Recordly ranges stay bound but hidden.
	await page.click("#tab-settings");
	assert.equal(await page.$eval("#panel-scene", (el) => el.hidden), true);
	assert.equal(await page.$eval("#panel-settings", (el) => el.hidden), false);
	await page.click("#tab-scene");
	assert.equal(await page.$eval("#panel-settings", (el) => el.hidden), true);
	assert.equal(await page.$eval("#frame-padding", (el) => !!el.closest("[hidden]")), true, "raw ranges are hidden, not dead");
	await page.click('#frame-padding-presets [data-value="40"]');
	assert.equal(await page.evaluate(() => glide.state.settings.frame.padding), 40, "padding preset writes the stored value");
	await page.click("#frame-shadow-toggle");
	assert.equal(await page.evaluate(() => glide.state.settings.frame.shadowIntensity), 0, "shadow toggle off writes 0");
	await page.click("#frame-shadow-toggle");
	assert.equal(await page.evaluate(() => glide.state.settings.frame.shadowIntensity > 0), true, "shadow toggle restores the default strength");
	await page.click('#frame-padding-presets [data-value="20"]');
	await page.click(".zoom-block");
	await page.click('#zoom-depth [data-value="4"]');
	const edited = await regions();
	assert.equal(edited[0].depth, 4);
	await page.reload();
	await ready();
	assert.deepEqual(await regions(), edited, "an immediate reload preserves depth and all region fields");

	await removeAll();
	await page.reload();
	await ready();
	assert.deepEqual(await regions(), [], "empty edits stay empty, not re-suggested");
	await page.goto(`${base}?id=persist-b`);
	await ready();
	assert.equal((await regions()).length, 3, "recording B does not inherit recording A's deletions");
	await page.goto(`${base}?id=persist-a`);
	await ready();
	assert.deepEqual(await regions(), [], "recording A is retained after opening B");

	// Add one manual segment, reload, then add another: IDs must remain unique after sequence reset.
	await page.click("#add-zoom");
	await page.click('#zoom-mode [data-value="manual"]');
	await page.click("#stage");
	const manual = await regions();
	assert.equal(manual[0].mode, "manual");
	await page.reload();
	await ready();
	assert.deepEqual(await regions(), manual, "manual focus/mode is restored");
	await page.focus("#timeline");
	await page.keyboard.press("ArrowRight");
	await page.keyboard.press("ArrowRight");
	await page.click("#add-zoom");
	const two = await regions();
	assert.equal(two.length, 2);
	assert.equal(new Set(two.map((r) => r.id)).size, 2, "new segments cannot reuse restored IDs");

	// A retained range is non-destructive: source-time zooms stay intact across reload.
	await page.evaluate(() => glide.seek(2500));
	await page.click("#trim-start");
	await page.evaluate(() => glide.seek(3500));
	await page.click("#trim-end");
	const trim = await page.evaluate(() => structuredClone(glide.state.trim));
	assert.deepEqual(trim, { startMs: 2500, endMs: 3500 });
	await page.reload();
	await ready();
	assert.deepEqual(await page.evaluate(() => glide.state.trim), trim, "trim survives immediate reload");
	assert.deepEqual(await regions(), two, "trimming never shifts or deletes source-time zooms");
	await page.click("#play");
	// Slow compositing can finish the short range before Puppeteer's click promise resolves.
	await page.waitForFunction(() => document.querySelector("#play").getAttribute("aria-pressed") === "false"
		&& Number(document.querySelector("#timeline").getAttribute("aria-valuenow")) === 3500, { timeout: 10000 });
	assert.equal(await page.$eval("#timeline", (e) => Number(e.getAttribute("aria-valuenow"))), 3500, "preview stops at retained end");
	await page.screenshot({ path: "test/out/trim-editor.png" });
	await page.goto(`${base}?id=persist-b`);
	await ready();
	assert.equal(await page.evaluate(() => glide.state.trim.startMs), 0, "B never inherits A's trim");
	await page.goto(`${base}?id=persist-a`);
	await ready();

	// Importing a file after opening A must not write back to A's saved zooms.
	const input = await page.$("#open-files");
	await input.uploadFile(resolve("test/fixtures/screen.webm"), resolve("test/fixtures/events.json"));
	await page.waitForFunction(() => glide.state.meta?.id === "local");
	await page.waitForFunction(() => glide.state.regions.length === 3);
	await removeAll();
	await page.goto(`${base}?id=persist-a`);
	await ready();
	assert.deepEqual(await regions(), two, "import edits never overwrite a prior recording");
	assert.deepEqual(await page.evaluate(() => glide.state.trim), trim, "imports never overwrite saved trim");
	await page.click("#trim-reset");
	await page.reload();
	await ready();
	assert.equal(await page.evaluate(() => glide.state.trim.startMs), 0);
	assert.equal(await page.evaluate(() => glide.state.trim.endMs === glide.state.durationMs), true);
	// Single-tab capture (surface "browser"): no browser chrome exists, so the control is disabled
	// and an old project that persisted hideTop: true still cannot crop preview or export.
	assert.equal(await page.$eval("#browser-hide-top", (el) => el.disabled), true, "tab capture disables hide-top");
	assert.equal(await page.$eval("#browser-hide-top", (el) => el.checked), false);
	await page.evaluate(() => {
		const key = "glide.project.v1." + encodeURIComponent("persist-a");
		const p = JSON.parse(localStorage.getItem(key));
		p.browserView = { hideTop: true, topPx: 120 };
		localStorage.setItem(key, JSON.stringify(p));
	});
	await page.reload();
	await ready();
	assert.equal(await page.evaluate(() => glide.state.browserView.hideTop), true, "the old saved crop is still restored");
	assert.equal(await page.$eval("#browser-hide-top", (el) => el.disabled), true);
	assert.equal(await page.$eval("#browser-hide-top", (el) => el.checked), false, "the control shows the effective state");
	assert.deepEqual(await page.evaluate(() => glide.crop()), { x: 0, y: 0, width: 1, height: 1 }, "old saved crop cannot crop a tab recording");
	assert.deepEqual(await regions(), two, "presentation crop never rewrites zoom coordinates");

	// Window capture keeps real browser chrome: the crop stays available, persists and is reversible.
	await page.goto(`${base}?id=persist-w`);
	await ready();
	assert.equal(await page.$eval("#browser-hide-top", (el) => el.disabled), false, "window capture can hide its top");
	await page.click("#browser-hide-top");
	await page.$eval("#browser-top-px", (el) => { el.value = "120"; el.dispatchEvent(new Event("input", { bubbles: true })); });
	assert.deepEqual(await page.evaluate(() => glide.state.browserView), { hideTop: true, topPx: 120 });
	const windowCrop = await page.evaluate(() => glide.crop());
	assert.ok(Math.abs(windowCrop.height - (1 - 120 / 720)) < 1e-9, `window crop projects into the source (${windowCrop.height})`);
	await page.reload();
	await ready();
	assert.deepEqual(await page.evaluate(() => glide.state.browserView), { hideTop: true, topPx: 120 }, "window crop survives reload");
	assert.equal(await page.$eval("#browser-hide-top", (el) => el.checked), true);
	assert.ok(Math.abs((await page.evaluate(() => glide.crop().height)) - (1 - 120 / 720)) < 1e-9);
	await page.screenshot({ path: "test/out/browser-top-hidden.png" });
	await page.goto(`${base}?id=persist-b`);
	await ready();
	assert.equal(await page.evaluate(() => glide.state.browserView.hideTop), false, "B has no inherited crop");
	await page.goto(`${base}?id=persist-w`);
	await ready();
	await page.click("#browser-hide-top");
	assert.deepEqual(await page.evaluate(() => glide.state.browserView), { hideTop: false, topPx: 120 }, "toggling full source keeps calibrated height");

	// Real UI export path: lock duplicate exports/imports immediately, then cancel without a long encode.
	const exportLock = await page.evaluate(() => {
		document.querySelector("#export-mp4").click();
		const locked = ["export-mp4", "export-webm", "open-files"].every((id) => document.getElementById(id).disabled);
		document.querySelector("#cancel").click();
		return locked;
	});
	assert.equal(exportLock, true, "export owns the export/import actions before async encoding starts");
	await page.waitForFunction(() => document.querySelector("#status").textContent === "Export cancelled", { timeout: 30000 });
	assert.equal(await page.$eval("#export-mp4", (el) => el.disabled), false, "cancellation releases the export lock");
	assert.equal(await page.$eval("#open-files", (el) => el.disabled), false);

	// Bad id: the recovery card is visible and announced, and nothing acts on missing media.
	await page.goto(`${base}?id=does-not-exist`);
	await page.waitForSelector("#empty:not([hidden])", { timeout: 10000 });
	assert.equal(await page.$eval("#empty", (el) => el.getAttribute("role")), "alert");
	const emptyText = await page.$eval("#empty p", (el) => el.textContent);
	assert.ok(/does-not-exist/.test(emptyText) && /Open files/.test(emptyText), `recovery copy: ${emptyText}`);
	assert.equal(await page.$eval("#export-mp4", (el) => el.disabled), true, "no export without media");
	assert.equal(await page.$eval("#export-webm", (el) => el.disabled), true);
	assert.equal(await page.$eval("#add-zoom", (el) => el.disabled), true, "no live +Zoom without media");
	assert.equal(await page.$eval("#trim-start", (el) => el.disabled), true, "no live trim without media");
	assert.equal(await page.$eval("#open-files", (el) => el.disabled), false, "Open files stays as the recovery path");
	console.log("EDITOR PERSISTENCE OK: zooms, trim, browser-top crop (tab guarded, window kept), import boundary, export cancellation/lock");
} finally {
	await browser.close();
}
