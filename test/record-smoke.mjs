// Smoke test of the real recording path (offscreen document + getDisplayMedia + fake mic/cam),
// using Chrome's auto-accept flags and host access in an isolated extension copy.
// PAGE_MODE=1 exercises the real popup → visible recorder route (without real desktop/media).
import { createServer } from "node:http";
import { resolve } from "node:path";
import puppeteer from "puppeteer-core";

const root = resolve(".");
const server = createServer((_q, r) => r.writeHead(200, { "content-type": "text/html" }).end("<title>GlideTarget</title><body style='background:linear-gradient(90deg,#f0f,#0ff);height:100vh'><button>Click</button>")).listen(0);
const port = server.address().port;
const browser = await puppeteer.launch({
	executablePath: process.env.CHROME ?? "/usr/bin/google-chrome",
	headless: process.env.HEADFUL ? false : true,
	enableExtensions: true,
	pipe: true,
	dumpio: !!process.env.DUMPIO,
	args: ["--no-sandbox", "--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream", ...(process.env.SURFACE === "monitor" ? ["--auto-select-desktop-capture-source=Entire screen"] : ["--auto-select-tab-capture-source-by-title=GlideTarget", "--auto-accept-this-tab-capture"])],
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
	if (process.env.PAGE_MODE) {
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
		start = { ok: text.startsWith("Recording "), text };
	} else {
		start = await popup.evaluate((SURFACE) => chrome.runtime.sendMessage({ target: "background", type: "start", opts: { mic: true, camera: true, surface: SURFACE } }), process.env.SURFACE ?? "browser");
	}
	console.log("start:", JSON.stringify(start));
	if (!start?.ok) throw new Error("start failed");
	await target.bringToFront();
	for (let i = 0; i < 20; i++) {
		await target.mouse.move(100 + i * 20, 100 + i * 10);
		if (i === 10) await target.mouse.click(300, 200);
		await new Promise((r) => setTimeout(r, 100));
	}
	const editorOpened = browser.waitForTarget((t) => t.url().includes("/editor.html?id="), { timeout: 20000 });
	console.log("pages:", (await browser.pages()).map((p) => p.url()).join(" | "));
	const ctl = await browser.newPage();
	await ctl.goto(`chrome-extension://${extId}/setup.html`);
	const status = await ctl.evaluate(() => chrome.runtime.sendMessage({ target: "background", type: "status" }));
	console.log("status:", JSON.stringify(status));
	if (!status?.recording) throw new Error("active recorder incorrectly reported as stopped");
	if (process.env.PAGE_MODE) {
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
	const n = await ed.evaluate(() => ({ events: glide.state.events.length, clicks: glide.state.telemetry.filter((p) => p.interactionType !== "move" && p.interactionType !== "mouseup").length, segs: glide.state.regions.length }));
	console.log("pointer data:", JSON.stringify(n));
	if (!n.events || !n.clicks) throw new Error("no pointer events captured");
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
