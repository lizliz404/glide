// Smoke test of the real recording path (offscreen document + getDisplayMedia + fake mic/cam), using
// Chrome's capture auto-selection flags and host access in an isolated extension copy.
// PAGE_MODE=1 exercises the real popup → visible recorder route (without real desktop/media).
//
// Two things this test refuses to fake (docs/QA.md P2-9):
//   * `--auto-accept-this-tab-capture` is not passed in page mode, because it made Chrome capture the
//     recorder tab while the test still reported success.
//   * The recorded video is decoded and its pixels are printed; the target-colour assertion only runs
//     where Chrome can actually be told which tab to share (headful: `HEADFUL=1 xvfb-run -a node
//     test/record-smoke.mjs`). Headless Chrome ignores the by-title selector here and shares the first
//     tab instead (measured: the middle pixel came back white, i.e. about:blank), so there the run
//     reports the frame check as unverified instead of asserting something it cannot observe.
import { existsSync } from "node:fs";
import { createServer } from "node:http";
import { resolve } from "node:path";
import puppeteer from "puppeteer-core";

const root = resolve(".");
const SURFACE = process.env.SURFACE ?? "browser";
const PAGE_MODE = !!process.env.PAGE_MODE;
// This box has google-chrome-stable and chromium; /usr/bin/google-chrome does not exist.
const chrome = [process.env.CHROME, "/usr/bin/google-chrome", "/usr/bin/google-chrome-stable", "/usr/bin/chromium"].find((p) => p && existsSync(p));
if (!chrome) throw new Error("no Chrome binary found");
const server = createServer((req, r) =>
	r
		.writeHead(200, { "content-type": "text/html" })
		.end(`<title>${req.url?.includes("decoy") ? "GlideDecoy" : "GlideTarget"}</title><body style='background:linear-gradient(90deg,#f0f,#0ff);height:100vh'><button>Click</button>`),
).listen(0);
const port = server.address().port;
const browser = await puppeteer.launch({
	executablePath: chrome,
	headless: process.env.HEADFUL ? false : true,
	enableExtensions: true,
	pipe: true,
	dumpio: !!process.env.DUMPIO,
	// No `--auto-accept-this-tab-capture` in page mode: it makes Chrome capture the recorder tab
	// itself, which is how this test used to pass while recording the wrong surface (P2-9). Headless
	// Chrome cannot be told which tab to share by title, so the offscreen path (no user gesture)
	// needs the flag to auto-accept a source at all; it then accepts the tab that is in front.
	args: ["--no-sandbox", "--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream", ...(SURFACE === "monitor" ? ["--auto-select-desktop-capture-source=Entire screen"] : PAGE_MODE ? ["--auto-select-tab-capture-source-by-title=GlideTarget"] : ["--auto-select-tab-capture-source-by-title=GlideTarget", "--auto-accept-this-tab-capture"])],
});
let code = 0;
try {
	// Test copy of the extension with host access pre-granted (the real build asks at runtime),
	// so the pointer-logging path is exercised too.
	const { cp, readFile: rf, writeFile: wf } = await import("node:fs/promises");
	const testDir = "/tmp/glide-dist-test";
	await cp(`${root}/dist`, testDir, { recursive: true, force: true });
	const mf = JSON.parse(await rf(`${testDir}/manifest.json`, "utf8"));
	mf.host_permissions = ["<all_urls>"];
	await wf(`${testDir}/manifest.json`, JSON.stringify(mf));
	const extId = await browser.installExtension(testDir);
	const target = await browser.newPage();
	await target.goto(`http://localhost:${port}/`);
	// Drive the extension from a background page context while the target tab stays visible
	// (a hidden tab produces no frames, so capture would time out).
	const popup = await browser.newPage();
	await popup.goto(`chrome-extension://${extId}/popup.html`);
	await target.bringToFront();
	let start;
	if (PAGE_MODE) {
		// Permission prompts only resolve from a visible page, even with fake devices.
		await popup.bringToFront();
		await popup.evaluate(async () => {
			const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: true });
			stream.getTracks().forEach((track) => track.stop());
		});
		await popup.select("#surface", "browser");
		await popup.click("#start");
		const recorder = await (await browser.waitForTarget((t) => t.url().includes("/recorder.html?page="), { timeout: 10000 })).page();
		await recorder.waitForSelector("#start");
		// A cancelled picker leaves the page. A second start must reuse it, not open another listener.
		const again = await browser.newPage();
		await again.goto(`chrome-extension://${extId}/popup.html`);
		await again.select("#surface", "browser");
		await again.click("#start");
		await new Promise((r) => setTimeout(r, 800));
		const recorders = (await browser.pages()).filter((p) => p.url().includes("/recorder.html?page="));
		if (recorders.length !== 1) throw new Error(`expected 1 recorder page, saw ${recorders.length}`);
		if (!again.isClosed()) await again.close().catch(() => {});
		if (recorder.isClosed()) throw new Error("existing recorder was closed instead of reused");
		await recorder.bringToFront();
		await recorder.click("#start");
		await target.bringToFront();
		await recorder.waitForFunction(() => /Recording |Timeout|Error/.test(document.querySelector("#status").textContent), { timeout: 20000 });
		const text = await recorder.$eval("#status", (e) => e.textContent);
		start = { ok: /^Recording(\s|\.)/.test(text), text };
	} else {
		// The offscreen document has no tab of its own, so "this tab" resolves to the front tab.
		await target.bringToFront();
		start = await popup.evaluate((SURFACE) => chrome.runtime.sendMessage({ target: "background", type: "start", opts: { mic: true, camera: true, surface: SURFACE } }), SURFACE);
	}
	console.log("start:", JSON.stringify(start));
	if (!start?.ok) throw new Error("start failed");
	// Clicks in a second, uncaptured tab must never reach this recording (docs/QA.md P1-3).
	const decoy = await browser.newPage();
	await decoy.goto(`http://localhost:${port}/?decoy=1`);
	await target.bringToFront();
	for (let i = 0; i < 8; i++) {
		await target.mouse.move(100 + i * 20, 100 + i * 10);
		if (i === 4) await target.mouse.click(300, 200);
		await new Promise((r) => setTimeout(r, 100));
	}
	await decoy.bringToFront();
	await decoy.mouse.click(200, 200);
	await new Promise((r) => setTimeout(r, 300));
	await target.bringToFront();
	for (let i = 8; i < 20; i++) {
		await target.mouse.move(100 + i * 20, 100 + i * 10);
		if (i === 14) await target.mouse.click(300, 200);
		await new Promise((r) => setTimeout(r, 100));
	}
	const editorOpened = browser.waitForTarget((t) => t.url().includes("/editor.html?id="), { timeout: 20000 });
	console.log("pages:", (await browser.pages()).map((p) => p.url()).join(" | "));
	const ctl = await browser.newPage();
	await ctl.goto(`chrome-extension://${extId}/setup.html`);
	const status = await ctl.evaluate(() => chrome.runtime.sendMessage({ target: "background", type: "status" }));
	console.log("status:", JSON.stringify(status));
	if (!status?.recording) throw new Error("active recorder incorrectly reported as stopped");
	// The pointer logger must be live in the target tab at the same time as its events are dropped:
	// that is what separates "fail closed" from "logging never ran" (P1-3).
	const logger = await ctl.evaluate(async (p) => {
		const tabs = await chrome.tabs.query({});
		const t = tabs.find((x) => (x.url ?? "").includes(`localhost:${p}`) && !x.url?.includes("decoy"));
		if (!t?.id) return { error: "target tab not found" };
		const [{ result }] = await chrome.scripting.executeScript({ target: { tabId: t.id }, func: () => window.__glideContent === true });
		return { tabId: t.id, injected: result };
	}, port);
	console.log("pointer logger in target tab:", JSON.stringify(logger));
	if (logger.injected !== true) throw new Error("pointer logger was not injected into the target tab");
	if (PAGE_MODE) {
		const checkPopup = await browser.newPage();
		await checkPopup.goto(`chrome-extension://${extId}/popup.html`);
		await checkPopup.waitForSelector("#stop:not([hidden])");
		await checkPopup.close();
	}
	const stop = await ctl.evaluate(() => chrome.runtime.sendMessage({ target: "background", type: "stop" }));
	console.log("stop:", JSON.stringify(stop));
	const edTarget = await editorOpened;
	const ed = await edTarget.page();
	await ed.waitForSelector("body[data-ready]", { timeout: 20000 });
	console.log("editor:", await ed.$eval("#status", (e) => e.textContent));
	const n = await ed.evaluate(() => ({ events: glide.state.events.length, clicks: glide.state.telemetry.filter((p) => p.interactionType !== "move" && p.interactionType !== "mouseup").length, regions: glide.state.regions.length }));
	console.log("pointer data:", JSON.stringify(n));
	// Fail-closed expectation (src/shared/pointerScope.ts): Glide cannot prove which surface was
	// captured, so it keeps no pointer data at all and neither the target clicks nor the decoy tab's
	// click can become a zoom. When an identity source is approved, assert: decoy 0 and target > 0.
	if (n.events || n.clicks || n.regions) throw new Error(`expected fail-closed pointer data, got ${JSON.stringify(n)}`);
	// Real-frame check: decode the recorded video and read the middle pixel. The fixture page is a
	// magenta-to-cyan gradient, so a correct capture is ~rgb(128,0,255); the recorder page is dark
	// (what P2-9 used to record) and a stalled frame is black.
	const frames = await ed.evaluate(async () => {
		const blob = glide.state.screenBlob;
		if (!blob) throw new Error("no recorded video");
		const url = URL.createObjectURL(blob);
		const v = document.createElement("video");
		v.muted = true;
		v.src = url;
		const ready = new Promise((res, rej) => {
			v.onloadeddata = () => res();
			v.onerror = () => rej(new Error("recorded video did not decode"));
		});
		v.load();
		await ready;
		const canvas = document.createElement("canvas");
		canvas.width = v.videoWidth;
		canvas.height = v.videoHeight;
		const ctx = canvas.getContext("2d");
		const out = { size: [v.videoWidth, v.videoHeight], durationMs: glide.state.durationMs, samples: [] };
		for (const f of [0.55, 0.75, 0.9]) {
			await new Promise((res) => {
				const to = setTimeout(res, 2000);
				v.onseeked = () => {
					clearTimeout(to);
					res();
				};
				v.currentTime = (glide.state.durationMs * f) / 1000;
			});
			ctx.drawImage(v, 0, 0);
			const d = ctx.getImageData(Math.floor(v.videoWidth / 2), Math.floor(v.videoHeight / 2), 1, 1).data;
			out.samples.push([d[0], d[1], d[2]]);
		}
		URL.revokeObjectURL(url);
		return out;
	});
	console.log("recorded frames:", JSON.stringify(frames));
	if (!frames.size[0] || !frames.size[1]) throw new Error(`recorded video has no frames: ${JSON.stringify(frames)}`);
	const onTarget = frames.samples.filter(([r, g, b]) => r > 60 && b > 140 && g < 100).length;
	if (SURFACE !== "monitor") {
		if (!process.env.HEADFUL) {
			console.log(`frame check: UNVERIFIED — headless Chrome ignored the by-title selector, so the recorded surface is whatever it picked (middle pixels ${JSON.stringify(frames.samples)}). Re-run headful with a display to assert the target pixels.`);
		} else if (onTarget === 0) {
			throw new Error(`recorded frames are not the target tab: ${JSON.stringify(frames.samples)}`);
		} else {
			console.log(`frame check: ${onTarget}/${frames.samples.length} sampled frames show the target tab`);
		}
	}
} catch (e) {
	console.error("FAIL", e.message);
	console.error("open pages:", (await browser.pages()).map((p) => p.url()).join(" | "));
	code = 1;
} finally {
	await browser.close();
	server.close();
}
console.log(code ? "RECORD SMOKE FAILED" : "RECORD SMOKE OK");
process.exit(code);
