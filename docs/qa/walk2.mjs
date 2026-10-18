// QA part 2: timeline interactions + gradient rendering on the fixture editor (dev ?src= mode).
import { createServer } from "node:http";
import { readFile, writeFile } from "node:fs/promises";
import { extname } from "node:path";
import puppeteer from "/workspace/glide/node_modules/puppeteer-core/lib/esm/puppeteer/puppeteer-core.js";
const OUT = "/workspace/glide-qa";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const findings = []; const note = (k, v) => { findings.push([k, v]); console.log("[qa2]", k, JSON.stringify(v)); };
const types = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".webm": "video/webm", ".png": "image/png", ".jpg": "image/jpeg", ".svg": "image/svg+xml", ".webp": "image/webp" };
const server = createServer(async (q, r) => {
	const p = decodeURIComponent(new URL(q.url, "http://x").pathname);
	const file = p.startsWith("/fixtures/") ? `/workspace/glide/test${p}` : `/workspace/glide/dist${p}`;
	try { const b = await readFile(file); r.writeHead(200, { "content-type": types[extname(file)] ?? "application/octet-stream" }).end(b); } catch { r.writeHead(404).end(); }
}).listen(0);
const port = server.address().port;
const browser = await puppeteer.launch({ executablePath: "/usr/bin/google-chrome", headless: true, args: ["--no-sandbox"], protocolTimeout: 600000 });
const errors = [];
try {
	const ed = await browser.newPage();
	ed.on("console", (m) => m.type() === "error" && errors.push(m.text())); ed.on("pageerror", (e) => errors.push(e.message));
	await ed.setViewport({ width: 1600, height: 960 });
	await ed.goto(`http://localhost:${port}/editor.html?src=/fixtures/screen.webm&cam=/fixtures/cam.webm&events=/fixtures/events.json`);
	await ed.waitForSelector("body[data-ready]", { timeout: 60000 }); await sleep(500);
	const regions = () => ed.evaluate(() => glide.state.regions.map((r) => ({ id: r.id, s: r.startMs, e: r.endMs, mode: r.mode, focus: r.focus })));
	note("initial regions", await regions());
	await ed.evaluate(() => glide.seek(4000)); await sleep(300);
	await ed.click("#add-zoom"); await sleep(300);
	const all = await regions(); const selId = await ed.evaluate(() => glide.state.selectedId);
	const added = all.find((r) => r.id === selId);
	note("+Zoom at 4.0s", { count: all.length, added });
	await ed.screenshot({ path: `${OUT}/09-zoom-added.png` });
	let b = await (await ed.$(`.zoom-block[data-id="${added.id}"]`)).boundingBox();
	await ed.mouse.move(b.x + b.width / 2, b.y + b.height / 2); await ed.mouse.down();
	await ed.mouse.move(b.x + b.width / 2 + 30, b.y + b.height / 2, { steps: 6 }); await ed.mouse.up(); await sleep(200);
	const moved = (await regions()).find((r) => r.id === added.id);
	b = await (await ed.$(`.zoom-block[data-id="${added.id}"]`)).boundingBox();
	await ed.mouse.move(b.x + b.width - 2, b.y + b.height / 2); await ed.mouse.down();
	await ed.mouse.move(b.x + b.width + 400, b.y + b.height / 2, { steps: 8 }); await ed.mouse.up(); await sleep(200);
	const resized = (await regions()).find((r) => r.id === added.id);
	note("drag +30px / resize right +400px (into next zoom at 6.0s)", { added: [added.s, added.e], moved: [moved.s, moved.e], resized: [resized.s, resized.e], overlapsNext: resized.e > 6000 });
	await ed.screenshot({ path: `${OUT}/09b-zoom-drag-resize.png` });
	// manual focus
	const modeBtn = await ed.$('#zoom-mode [data-value="manual"], [name="zoom-mode"][value="manual"], #zoom-manual');
	note("manual mode control found", !!modeBtn);
	if (modeBtn) { await modeBtn.click(); await sleep(200); }
	await ed.evaluate((ms) => glide.seek(ms), (resized.s + resized.e) / 2); await sleep(300);
	const c = await (await ed.$("canvas")).boundingBox();
	await ed.mouse.click(c.x + c.width * 0.75, c.y + c.height * 0.7); await sleep(300);
	note("manual focus after preview click (0.75,0.7)", (await regions()).find((r) => r.id === added.id));
	await ed.evaluate((ms) => glide.seek(ms), (resized.s + resized.e) / 2); await sleep(400);
	await ed.screenshot({ path: `${OUT}/10-manual-zoom-focus.png` });
	// undo?
	await ed.keyboard.down("Control"); await ed.keyboard.press("z"); await ed.keyboard.up("Control"); await sleep(200);
	note("Ctrl+Z after manual focus changes anything", JSON.stringify((await regions()).find((r) => r.id === added.id)?.focus));
	// Space after clicking a button (focus on button)
	await ed.click("#add-zoom"); await sleep(100);
	await ed.keyboard.press("Space"); await sleep(600);
	note("Space after clicking +Zoom: playing?", await ed.$eval("#play", (e) => e.getAttribute("aria-pressed")));
	if ((await ed.$eval("#play", (e) => e.getAttribute("aria-pressed"))) === "true") await ed.click("#play");
	note("regions after Space-on-button", (await regions()).length);
	// Delete
	await ed.evaluate((id) => glide.selectRegion(id), added.id);
	await ed.focus("body"); await ed.keyboard.press("Delete"); await sleep(200);
	note("Delete removes selected", !(await regions()).some((r) => r.id === added.id));
	// keyboard 'z' (Recordly addZoom shortcut)
	const n = (await regions()).length; await ed.evaluate(() => glide.seek(4000)); await ed.focus("body"); await ed.keyboard.press("z"); await sleep(200);
	note("'z' adds a zoom like Recordly", (await regions()).length > n);
	// gradients: sample canvas center-left background pixel for each gradient
	await ed.click("#tab-scene"); await ed.click('[data-bg-tab="gradient"]'); await sleep(200);
	const sw = await ed.$$("#gradients [role=radio]"); const res = [];
	for (let i = 0; i < sw.length; i++) {
		await sw[i].click(); await sleep(350);
		res.push(await ed.evaluate(() => { const cv = document.querySelector("canvas"); const x = cv.getContext("2d") ?? null; if (!x) return "no2d"; const d = x.getImageData(4, Math.floor(cv.height / 2), 1, 1).data; return [...d].slice(0, 3).join(","); }));
	}
	note("gradient edge pixel per preset (0,0,0 = black fallback)", res);
	await sw[0].click(); await sleep(300); await ed.screenshot({ path: `${OUT}/13b-gradient1-black.png` });
	// tab order
	const order = await ed.evaluate(() => [...document.querySelectorAll("button,input,select,[tabindex]")].filter((e) => e.offsetParent && e.tabIndex >= 0).length);
	note("focusable controls", order);
	const unlabeled = await ed.evaluate(() => [...document.querySelectorAll("input,select,button")].filter((e) => e.offsetParent && !(e.labels?.length) && !e.getAttribute("aria-label") && !e.textContent.trim()).map((e) => e.id || e.outerHTML.slice(0, 60)));
	note("visible controls without accessible name", unlabeled);
	// double export
	await ed.click("#export-mp4"); await sleep(1500);
	const during = await ed.evaluate(() => ({ mp4: document.querySelector("#export-mp4")?.disabled, webm: document.querySelector("#export-webm")?.disabled, open: document.querySelector("#open")?.disabled, status: document.querySelector("#status").textContent }));
	note("during export", during);
	await ed.click("#export-webm"); await sleep(1500);
	note("after clicking WebM mid-export", await ed.$eval("#status", (e) => e.textContent));
	await ed.screenshot({ path: `${OUT}/19b-double-export.png` });
	await ed.click("#cancel").catch(() => {}); await sleep(1000);
	note("after cancel", await ed.$eval("#status", (e) => e.textContent));
} catch (e) { note("ERROR", String(e.stack ?? e)); }
note("errors", errors);
await writeFile(`${OUT}/walk2-findings.json`, JSON.stringify(findings, null, 1));
await browser.close(); server.close();
