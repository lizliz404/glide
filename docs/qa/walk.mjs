// QA walkthrough: real popup -> setup -> recorder (tab mode) -> editor, then every editor control.
// Run from /workspace/glide under xvfb (headful; tab capture needs a visible target).
import { execFileSync } from "node:child_process";
import { createServer } from "node:http";
import { cp, readFile, writeFile, mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import puppeteer from "/workspace/glide/node_modules/puppeteer-core/lib/esm/puppeteer/puppeteer-core.js";

const root = resolve(".");
const OUT = "/workspace/glide-qa";
const STEP = process.env.STEP ?? "all";
const log = (...a) => console.log("[qa]", ...a);
const findings = [];
const note = (k, v) => { findings.push([k, v]); log(k, typeof v === "string" ? v : JSON.stringify(v)); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const server = createServer((_q, r) => r.writeHead(200, { "content-type": "text/html" }).end(`<title>GlideTarget</title><body style="margin:0;font:24px sans-serif;background:linear-gradient(90deg,#fde68a,#93c5fd);height:100vh"><h1 style="margin:40px">Demo page</h1><button id=a style="position:absolute;left:200px;top:200px;font-size:28px">Sign up</button><input id=b style="position:absolute;left:900px;top:500px;font-size:28px" placeholder="Email"><a href="#" id=c style="position:absolute;left:1400px;top:800px">Docs</a></body>`)).listen(0);
const port = server.address().port;

const testDir = "/tmp/glide-dist-qa";
await cp(`${root}/dist`, testDir, { recursive: true, force: true });
const mf = JSON.parse(await readFile(`${testDir}/manifest.json`, "utf8"));
mf.host_permissions = ["<all_urls>"]; // pre-grant site access (prompt can't be clicked in automation)
await writeFile(`${testDir}/manifest.json`, JSON.stringify(mf));

const browser = await puppeteer.launch({
	executablePath: "/usr/bin/google-chrome", headless: false, enableExtensions: true, pipe: true,
	protocolTimeout: 30 * 60 * 1000, defaultViewport: null,
	args: ["--no-sandbox", "--window-size=1600,1000", "--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream",
		"--auto-select-tab-capture-source-by-title=GlideTarget", "--auto-accept-this-tab-capture"],
});
const extId = await browser.installExtension(testDir);
const ext = (p) => `chrome-extension://${extId}/${p}`;
const errors = [];
const watch = (page, name) => { page.on("pageerror", (e) => errors.push(`${name}: ${e.message}`)); page.on("console", (m) => m.type() === "error" && errors.push(`${name} console: ${m.text()}`)); };
const shot = async (page, name) => { await page.screenshot({ path: `${OUT}/${name}.png` }); log("shot", name); };
try {
	const target = await browser.newPage(); watch(target, "target");
	await target.setViewport({ width: 1600, height: 900 });
	await target.goto(`http://localhost:${port}/`);

	// 1) Popup (rendered in a tab at popup size)
	const popup = await browser.newPage(); watch(popup, "popup");
	await popup.setViewport({ width: 320, height: 420 });
	await popup.goto(ext("popup.html"));
	await sleep(500);
	await shot(popup, "01-popup-first-run");
	note("popup default surface", await popup.$eval("#surface", (s) => s.value));

	// 2) First Record click without mic/cam grant -> setup page?
	const before = (await browser.pages()).length;
	await popup.click("#start");
	await sleep(1200);
	const pages = await browser.pages();
	const setup = pages.find((p) => p.url().includes("setup.html"));
	note("first Record opens setup page", !!setup);
	if (setup) {
		watch(setup, "setup");
		await setup.setViewport({ width: 1100, height: 600 });
		await shot(setup, "02-setup-permissions");
		await setup.click("#grant");
		await sleep(1500);
		note("setup status after grant", await setup.$eval("#status", (e) => e.textContent));
		await shot(setup, "03-setup-granted");
	}
	note("popup still open after setup redirect", !popup.isClosed());
	// 3) Record again (tab mode) -> visible recorder page
	const popup2 = popup.isClosed() ? await browser.newPage() : popup;
	if (popup2 !== popup) { watch(popup2, "popup2"); await popup2.setViewport({ width: 320, height: 420 }); }
	await popup2.goto(ext("popup.html"));
	await popup2.select("#surface", "browser");
	await shot(popup2, "04-popup-single-tab");
	await popup2.click("#start");
	const recT = await browser.waitForTarget((t) => t.url().includes("/recorder.html?page="), { timeout: 10000 }).catch(() => null);
	note("Record (tab) opens visible recorder page", !!recT);
	const rec = await recT.page(); watch(rec, "recorder");
	await rec.setViewport({ width: 1100, height: 600 });
	await rec.waitForSelector("#start");
	await shot(rec, "05-recorder-page");
	await rec.click("#start");
	await target.bringToFront();
	await rec.waitForFunction(() => /Recording |Error|Timeout|denied/i.test(document.querySelector("#status").textContent), { timeout: 20000 }).catch(() => {});
	note("recorder status", await rec.$eval("#status", (e) => e.textContent));
	// interact on target ~8 s
	const m = target.mouse;
	await m.move(800, 450); await sleep(400);
	for (const [x, y, sel] of [[260, 220, "#a"], [1000, 515, "#b"], [1420, 805, "#c"]]) {
		for (let i = 0; i < 20; i++) { await m.move(x - 200 + i * 10, y - 100 + i * 5); await sleep(30); }
		await m.click(x, y); await sleep(1500);
	}
	await sleep(800);
	// Popup status while recording + stop from popup
	const popup3 = await browser.newPage(); watch(popup3, "popup3");
	await popup3.setViewport({ width: 320, height: 420 });
	await popup3.goto(ext("popup.html"));
	await sleep(800);
	await shot(popup3, "06-popup-recording");
	note("popup while recording", await popup3.$eval("#status", (e) => e.textContent));
	const edT = browser.waitForTarget((t) => t.url().includes("/editor.html?id="), { timeout: 30000 }).catch(() => null);
	await popup3.click("#stop");
	const edTarget = await edT;
	note("stop -> editor opens", !!edTarget);
	const ed = await edTarget.page(); watch(ed, "editor");
	await ed.setViewport({ width: 1600, height: 960 });
	await ed.waitForSelector("body[data-ready]", { timeout: 60000 });
	await sleep(800);
	const recId = new URL(ed.url()).searchParams.get("id");
	note("editor status", await ed.$eval("#status", (e) => e.textContent));
	note("recorder tab left open after stop", !rec.isClosed() && (await browser.pages()).some((p) => p.url().includes("recorder.html")));
	const st = await ed.evaluate(() => ({ events: glide.state.events.length, regions: glide.state.regions.map((r) => [r.startMs, r.endMs, r.depth]), dur: glide.state.durationMs, cursor: glide.state.settings.cursor.show, surface: glide.state.meta.surface }));
	note("editor state", st);
	await shot(ed, "07-editor-fresh-recording");

	// 4) Rail panels
	for (const s of ["cursor", "webcam", "settings", "scene"]) { await ed.click(`#tab-${s}`); await sleep(250); await shot(ed, `08-panel-${s}`); }

	// 5) Timeline: add zoom at playhead, drag, resize, delete
	const tl = await ed.$("#zoom-track"); const box = await tl.boundingBox();
	const dur = st.dur;
	const xAt = (ms) => box.x + (ms / dur) * box.width;
	await ed.mouse.click(xAt(dur * 0.05), box.y - 20); await sleep(300); // seek via ruler
	const n0 = await ed.evaluate(() => glide.state.regions.length);
	await ed.click("#add-zoom"); await sleep(300);
	const added = await ed.evaluate(() => glide.state.regions.find((r) => r.id === glide.state.selectedId));
	note("+Zoom at playhead", { before: n0, after: await ed.evaluate(() => glide.state.regions.length), added });
	await shot(ed, "09-zoom-added-panel");
	if (added) {
		const b = await ed.$(`.zoom-block[data-id="${added.id}"]`); const bb = await b.boundingBox();
		// drag body
		await ed.mouse.move(bb.x + bb.width / 2, bb.y + bb.height / 2); await ed.mouse.down();
		await ed.mouse.move(bb.x + bb.width / 2 + 40, bb.y + bb.height / 2, { steps: 5 }); await ed.mouse.up(); await sleep(200);
		const moved = await ed.evaluate((id) => glide.state.regions.find((r) => r.id === id), added.id);
		const b2 = await (await ed.$(`.zoom-block[data-id="${added.id}"]`)).boundingBox();
		// resize right edge
		await ed.mouse.move(b2.x + b2.width - 2, b2.y + b2.height / 2); await ed.mouse.down();
		await ed.mouse.move(b2.x + b2.width + 60, b2.y + b2.height / 2, { steps: 5 }); await ed.mouse.up(); await sleep(200);
		const resized = await ed.evaluate((id) => glide.state.regions.find((r) => r.id === id), added.id);
		note("drag/resize", { added: [added.startMs, added.endMs], moved: moved && [moved.startMs, moved.endMs], resized: resized && [resized.startMs, resized.endMs] });
		// manual focus
		await ed.click('#zoom-mode [data-value="manual"]'); await sleep(200);
		const cbox = await (await ed.$("#stage")).boundingBox();
		await ed.mouse.click(cbox.x + cbox.width * 0.75, cbox.y + cbox.height * 0.7); await sleep(300);
		const foc = await ed.evaluate((id) => glide.state.regions.find((r) => r.id === id)?.focus, added.id);
		note("manual focus after clicking preview at (0.75,0.7)", foc);
		await ed.evaluate((ms) => glide.seek(ms), (resized.startMs + resized.endMs) / 2); await sleep(400);
		await shot(ed, "10-manual-zoom-focus");
		// keyboard delete
		await ed.focus(`.zoom-block[data-id="${added.id}"]`);
		await ed.keyboard.press("Delete"); await sleep(200);
		note("Delete key removes selected zoom", !(await ed.evaluate((id) => glide.state.regions.some((r) => r.id === id), added.id)));
	}
	// Space / arrows
	await ed.click("#timeline"); const t0 = await ed.evaluate(() => document.querySelector("#timeline").getAttribute("aria-valuenow"));
	await ed.keyboard.press("ArrowRight"); await sleep(300);
	const t1 = await ed.evaluate(() => document.querySelector("#timeline").getAttribute("aria-valuenow"));
	await ed.keyboard.press("Space"); await sleep(1200);
	const playing = await ed.evaluate(() => document.querySelector("#play").getAttribute("aria-pressed"));
	await ed.keyboard.press("Space"); await sleep(300);
	note("keyboard", { arrowSeek: [t0, t1], spaceTogglesPlay: playing });

	// 6) Aspect, wallpaper, webcam, browser top
	await ed.select("#aspect", "9:16"); await sleep(500); await shot(ed, "11-aspect-9x16");
	await ed.select("#aspect", "16:9");
	await ed.click("#tab-scene"); const wps = await ed.$$("#wallpapers [role=radio]"); await wps[2].click(); await sleep(800);
	await shot(ed, "12-wallpaper-switch");
	await ed.click('[data-bg-tab="gradient"]'); await sleep(200); await (await ed.$$("#gradients [role=radio]"))[0].click(); await sleep(400);
	await shot(ed, "13-gradient");
	await ed.click('[data-bg-tab="image"]'); await (await ed.$$("#wallpapers [role=radio]"))[0].click(); await sleep(500);
	await ed.click("#tab-webcam"); await ed.click("#webcam-show"); await sleep(400);
	await shot(ed, "14-webcam-off");
	note("webcam toggled", await ed.evaluate(() => glide.state.settings.webcam.enabled));
	await ed.click("#webcam-show"); await sleep(200);
	await ed.click("#tab-scene");
	note("browser-top hint (tab rec)", await ed.$eval("#browser-top-hint", (e) => e.textContent));
	await ed.click("#browser-hide-top"); await sleep(600);
	await shot(ed, "15-browser-top-hidden-tab-recording");
	note("browser top state", await ed.evaluate(() => glide.state.browserView));
	// trim
	await ed.evaluate((ms) => glide.seek(ms), 1000); await ed.click("#trim-start");
	await ed.evaluate((ms) => glide.seek(ms), dur - 1000); await ed.click("#trim-end"); await sleep(300);
	note("trim", { trim: await ed.evaluate(() => glide.state.trim), label: await ed.$eval("#trim-range", (e) => e.textContent) });
	await shot(ed, "16-trim");
	const savedRegions = await ed.evaluate(() => JSON.stringify(glide.state.regions));

	// 7) Reopen: reload + via Recent link in popup
	await ed.reload(); await ed.waitForSelector("body[data-ready]", { timeout: 60000 }); await sleep(500);
	const re = await ed.evaluate(() => ({ regions: JSON.stringify(glide.state.regions), trim: glide.state.trim, bv: glide.state.browserView }));
	note("reopen (reload) keeps edits", { regionsSame: re.regions === savedRegions, trim: re.trim, browserView: re.bv });
	await shot(ed, "17-reopened");
	const popup4 = await browser.newPage(); await popup4.setViewport({ width: 320, height: 480 }); await popup4.goto(ext("popup.html")); await sleep(800);
	await shot(popup4, "18-popup-recent");
	note("recent list", await popup4.$$eval("#recent a", (as) => as.map((a) => a.textContent)));
	await popup4.close();
	// undo browser-top for export realism, keep trim
	await ed.click("#tab-scene"); await ed.click("#browser-hide-top"); await sleep(300);

	// 8) Export UX: progress + cancel, then real exports via hook
	await ed._client().send("Browser.setDownloadBehavior", { behavior: "allow", downloadPath: OUT }).catch(() => {});
	await ed.click("#export-mp4"); await sleep(2500);
	await shot(ed, "19-export-progress");
	note("export progress UI", await ed.evaluate(() => ({ status: document.querySelector("#status").textContent, progressHidden: document.querySelector("#progress").hidden, cancelHidden: document.querySelector("#cancel").hidden, exportDisabled: document.querySelector("#export-mp4").disabled, controlsDuring: document.querySelector("#frame-padding").disabled })));
	await ed.click("#cancel"); await sleep(1500);
	note("after cancel", await ed.$eval("#status", (e) => e.textContent));
	await shot(ed, "20-export-cancelled");
	for (const c of ["mp4", "webm"]) {
		const t = Date.now();
		const res = await ed.evaluate((c) => glide.export(c), c);
		const out = `${OUT}/qa-export.${c}`;
		await writeFile(out, Buffer.from(res.b64, "base64"));
		const probe = JSON.parse(execFileSync("ffprobe", ["-v", "error", "-show_entries", "stream=codec_type,codec_name,width,height,nb_read_frames:format=duration", "-count_frames", "-of", "json", out]).toString());
		note(`export ${c}`, { secs: ((Date.now() - t) / 1000).toFixed(1), codecs: `${res.videoCodec}/${res.audioCodec}`, duration: probe.format.duration, streams: probe.streams });
		execFileSync("ffmpeg", ["-v", "error", "-y", "-ss", "2", "-i", out, "-frames:v", "1", `${OUT}/21-export-frame-${c}.png`]);
	}
	// 9) Empty + error states
	const e1 = await browser.newPage(); await e1.setViewport({ width: 1600, height: 960 }); await e1.goto(ext("editor.html")); await sleep(800); await shot(e1, "22-editor-empty");
	await e1.goto(ext("editor.html?id=does-not-exist")); await sleep(1200); await shot(e1, "23-editor-bad-id");
	note("bad id status", await e1.$eval("#status", (e) => e.textContent));
	await e1.goto(ext("editor.html")); await sleep(500);
	note("empty state export buttons enabled", await e1.evaluate(() => !document.querySelector("#export-mp4").disabled));
	await e1.click("#export-mp4"); await sleep(300); note("export with no recording -> status", await e1.$eval("#status", (e) => e.textContent));
	note("recId", recId);
} catch (e) {
	note("SCRIPT ERROR", String(e?.stack ?? e));
} finally {
	note("page errors", errors);
	await writeFile(`${OUT}/walk-findings.json`, JSON.stringify(findings, null, 1));
	await browser.close(); server.close();
}
