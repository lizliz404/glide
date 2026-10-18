// Real extension-origin regression: user zoom edits survive immediate reload, including [];
// recordings are isolated and raw/dev imports never inherit another recording's project.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import puppeteer from "puppeteer-core";

const root = resolve(".");
const browser = await puppeteer.launch({
	executablePath: process.env.CHROME ?? "/usr/bin/chromium",
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
			for (const id of ["persist-a", "persist-b"]) tx.objectStore("recordings").put({
				meta: { ...fixture.meta, id, createdAt: Date.now(), startedAt: 0, durationMs: 12000 },
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
	await page.click(".zoom-block");
	await page.click('#zoom-depth [data-value="5"]');
	const edited = await regions();
	assert.equal(edited[0].depth, 5);
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
	// Post-recording browser chrome choice: reversible, independent of temporal trim, scoped to A.
	await page.click("#browser-hide-top");
	await page.$eval("#browser-top-px", (el) => { el.value = "120"; el.dispatchEvent(new Event("input", { bubbles: true })); });
	const beforeCrop = await regions();
	await page.reload();
	await ready();
	assert.deepEqual(await page.evaluate(() => glide.state.browserView), { hideTop: true, topPx: 120 });
	assert.deepEqual(await regions(), beforeCrop, "presentation crop never rewrites zoom coordinates");
	assert.equal(await page.$eval("#browser-hide-top", (el) => el.checked), true);
	await page.screenshot({ path: "test/out/browser-top-hidden.png" });
	await page.goto(`${base}?id=persist-b`);
	await ready();
	assert.equal(await page.evaluate(() => glide.state.browserView.hideTop), false, "B has no inherited crop");
	await page.goto(`${base}?id=persist-a`);
	await ready();
	await page.click("#browser-hide-top");
	assert.equal(await page.evaluate(() => glide.state.browserView.hideTop), false);
	assert.equal(await page.evaluate(() => glide.state.browserView.topPx), 120, "toggling full source keeps calibrated height");
	console.log("EDITOR PERSISTENCE OK: zooms, trim, browser top reload/reset/isolation, import boundary");
} finally {
	await browser.close();
}
