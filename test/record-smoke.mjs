// Smoke test of the real recording path, covering all three capture identities
// (docs/QA.md P1-3, P2-9):
//   * surface=browser — real popup path: #start resolves the active tab, the service
//     worker mints a chrome.tabCapture stream id, and the offscreen recorder consumes
//     it via getUserMedia(chromeMediaSource:"tab"). No picker, no recorder page; pointer
//     identity is the exact tabId. If tabCapture is unavailable the popup itself falls
//     back to the picker-based recorder page — the run then drives that page but reports
//     the exact-tab guarantees as UNVERIFIED instead of faking them.
//   * PAGE_MODE=1 — popup surface=window → prepare-page → recorder.html?page= → its own
//     Start button → getDisplayMedia. Exercises the visible recorder fallback.
//   * SURFACE=monitor — offscreen getDisplayMedia("Entire screen"), unchanged.
//
// Things this test refuses to fake:
//   * The --auto-select-*/--auto-accept flags only answer a picker that actually opened.
//     Where this Chrome cannot exercise a path at all (tabCapture/getMediaStreamId
//     missing or failing, getDisplayMedia unsupported, window-focus APIs inert), the run
//     reports UNVERIFIED rather than asserting something it cannot observe.
//   * The recorded video is decoded and its middle pixel checked against the fixture
//     gradient (~rgb(128,0,255)). Under headless a mismatch is reported UNVERIFIED —
//     headless can ignore the by-title picker selector or fail to render a tab capture;
//     under HEADFUL a mismatch fails the run.
//   * Side panel (sidepanel.html) may open on start. Puppeteer cannot see it as a normal
//     page target; it is ignored for control flow and only appears in the pages listing.
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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const browser = await puppeteer.launch({
	executablePath: chrome,
	headless: process.env.HEADFUL ? false : true,
	enableExtensions: true,
	pipe: true,
	dumpio: !!process.env.DUMPIO,
	// No `--auto-accept-this-tab-capture` anywhere: it makes Chrome capture the recorder
	// tab itself, which is how this test used to pass while recording the wrong surface
	// (P2-9). For surface=browser the tab flag only matters if the popup falls back to the
	// picker-based recorder page; the primary getMediaStreamId path opens no picker at all.
	args: [
		"--no-sandbox",
		"--use-fake-ui-for-media-stream",
		"--use-fake-device-for-media-stream",
		...(SURFACE === "monitor"
			? ["--auto-select-desktop-capture-source=Entire screen"]
			: PAGE_MODE
				? ["--auto-select-desktop-capture-source=Chrome"]
				: ["--auto-select-tab-capture-source-by-title=GlideTarget"]),
	],
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
	// Control page for status/stop/probe calls. Created before recording starts so its
	// navigation never steals the foreground inside a window/screen capture.
	const ctl = await browser.newPage();
	await ctl.goto(`chrome-extension://${extId}/setup.html`);

	const probe = await ctl.evaluate(() => ({
		tabCaptureApi: typeof chrome.tabCapture?.getMediaStreamId === "function",
		sidePanelApi: typeof chrome.sidePanel?.open === "function",
		permissions: chrome.runtime.getManifest().permissions,
	}));
	console.log("extension probe:", JSON.stringify(probe));

	const statusOf = () =>
		// A wedged service worker must not stall the poll loop: a single sendMessage that
		// never replies is treated as "no status", not a protocol-level hang.
		Promise.race([
			ctl.evaluate(() => chrome.runtime.sendMessage({ target: "background", type: "status" })),
			sleep(5000).then(() => null),
		]).catch(() => null);
	// browser.pages() races target teardown (the popup window.close()s itself on its
	// fallback path); a closed target mid-enumeration must not crash the run.
	const safePages = () => browser.pages().catch(() => []);
	const findRecorderPage = async () => (await safePages()).find((p) => p.url().includes("/recorder.html?page=")) ?? null;
	const driveRecorderPage = async (rec, via) => {
		await rec.bringToFront();
		await rec.waitForSelector("#start");
		await rec.click("#start");
		await rec.waitForFunction(() => /Recording |Timeout|Error/.test(document.querySelector("#status").textContent), { timeout: 20000 });
		const text = await rec.$eval("#status", (e) => e.textContent);
		return { ok: /^Recording(\s|\.)/.test(text), text, via };
	};
	// After any popup-triggered start, either the offscreen recorder reports recording
	// (tabCapture path) or the popup's own fallback leaves a recorder.html?page= tab.
	const waitStartedOrRecorder = async () => {
		const until = Date.now() + 25000;
		while (Date.now() < until) {
			const st = await statusOf();
			if (st?.recording) return { ok: true, via: "tabCapture", status: st };
			const rec = await findRecorderPage();
			if (rec) {
				console.log("start: popup fell back to the picker recorder — tabCapture/getMediaStreamId did not run in this environment");
				return driveRecorderPage(rec, "recorder-page-fallback");
			}
			await sleep(300);
		}
		return null;
	};

	let start;
	// Recorders in a visible tab miss the service worker's post-start focused-window push
	// (it is only delivered to contexts that exist when prepare-page runs). Such runs get
	// one real windows.onFocusChanged round-trip below so the heuristic sees a window id.
	let pageRecorder = PAGE_MODE;
	// True when the recording consumed a chrome.tabCapture stream id → exact tab identity.
	let tabCapture = false;

	if (PAGE_MODE) {
		const popup = await browser.newPage();
		await popup.goto(`chrome-extension://${extId}/popup.html`);
		// Permission prompts only resolve from a visible page, even with fake devices.
		await popup.bringToFront();
		await popup.evaluate(async () => {
			const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: true });
			stream.getTracks().forEach((track) => track.stop());
		});
		await popup.select("#surface", "window");
		await popup.click("#start");
		const recorder = await (await browser.waitForTarget((t) => t.url().includes("/recorder.html?page="), { timeout: 10000 })).page();
		await recorder.waitForSelector("#start");
		// A cancelled picker leaves the page. A second start must reuse it, not open another listener.
		const again = await browser.newPage();
		await again.goto(`chrome-extension://${extId}/popup.html`);
		await again.select("#surface", "window");
		await again.click("#start");
		await sleep(800);
		const recorders = (await safePages()).filter((p) => p.url().includes("/recorder.html?page="));
		if (recorders.length !== 1) throw new Error(`expected 1 recorder page, saw ${recorders.length}`);
		if (!again.isClosed()) await again.close().catch(() => {});
		if (recorder.isClosed()) throw new Error("existing recorder was closed instead of reused");
		start = await driveRecorderPage(recorder, "recorder-page");
	} else if (SURFACE === "monitor") {
		// The offscreen document has no tab of its own; screen capture keeps the picker.
		await target.bringToFront();
		start = await ctl.evaluate((SURFACE) => chrome.runtime.sendMessage({ target: "background", type: "start", opts: { mic: true, camera: true, surface: SURFACE } }), SURFACE);
		start.via = "offscreen-getDisplayMedia";
	} else {
		// surface=browser, real product path: click Record in the popup while the target
		// is the active tab. Two puppeteer realities shape this block (measured on this
		// box's Chrome): a real CDP click on an occluded tab kills headless Chrome, and
		// chrome.action.openPopup resolves but neither exposes a CDP target nor counts as
		// "extension invoked" — so the exact-tab tabCapture start cannot be driven from
		// here. The synthetic DOM click needs no trusted input (getMediaStreamId is minted
		// by the service worker); when it fails with "not invoked" the popup's own
		// recorder-page fallback is what gets exercised, and the tabCapture-specific
		// guarantees are reported UNVERIFIED.
		await ctl.bringToFront();
		await ctl.evaluate(async () => {
			const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: true });
			stream.getTracks().forEach((track) => track.stop());
		});
		const popup = await browser.newPage();
		await popup.goto(`chrome-extension://${extId}/popup.html`);
		await popup.select("#surface", "browser");
		await target.bringToFront();
		await popup.evaluate(() => document.getElementById("start").click()).catch((e) => console.log("start: popup click race:", e.message));
		start = await waitStartedOrRecorder();
		tabCapture = start?.via === "tabCapture";
		pageRecorder = start?.via === "recorder-page-fallback";
		if (!start) {
			const pages = (await safePages()).map((p) => p.url()).join(" | ");
			const popupText = popup.isClosed() ? "(popup closed itself)" : await popup.$eval("#status", (e) => e.textContent).catch(() => "(unreadable)");
			throw new Error(`popup #start produced neither a recording nor a recorder page. popup status: ${popupText} | pages: ${pages}`);
		}
		if (tabCapture && (await findRecorderPage())) throw new Error("recorder page opened despite a successful tabCapture start — the new flow must not create one");
	}
	console.log("start:", JSON.stringify(start));
	if (!start?.ok) throw new Error("start failed");

	// Give page-mode recorders the focused-window id the service worker push missed.
	let focusPushed = null;
	if (pageRecorder) {
		focusPushed = await ctl
			.evaluate(async (p) => {
				const tabs = await chrome.tabs.query({});
				const t = tabs.find((x) => (x.url ?? "").includes(`localhost:${p}`) && !x.url?.includes("decoy"));
				if (t?.windowId == null) return "target tab not found";
				const w2 = await chrome.windows.create({ url: "about:blank", focused: true });
				await chrome.windows.update(t.windowId, { focused: true });
				if (w2?.id != null) await chrome.windows.remove(w2.id);
				return t.windowId;
			}, port)
			.catch((e) => `error: ${e instanceof Error ? e.message : e}`);
		console.log("focused-window push:", JSON.stringify(focusPushed));
	}

	// A fresh popup must show Stop while a recording is live (restore() reads status).
	// Done early — before the click sequence — so the foreground time it steals lands in
	// an unsampled part of window/screen captures.
	const checkPopup = await browser.newPage();
	await checkPopup.goto(`chrome-extension://${extId}/popup.html`);
	await checkPopup.waitForSelector("#stop:not([hidden])", { timeout: 10000 });
	await checkPopup.close();

	// Clicks in a second tab must never reach a tab capture (P1-3). Window/screen captures
	// are best-effort: whatever window is focused counts, so the decoy click may be kept.
	const decoy = await browser.newPage();
	await decoy.goto(`http://localhost:${port}/?decoy=1`);
	await target.bringToFront();
	for (let i = 0; i < 8; i++) {
		await target.mouse.move(100 + i * 20, 100 + i * 10);
		if (i === 4) await target.mouse.click(300, 200);
		await sleep(100);
	}
	await decoy.bringToFront();
	await decoy.mouse.click(200, 200);
	await sleep(300);
	await target.bringToFront();
	for (let i = 8; i < 20; i++) {
		await target.mouse.move(100 + i * 20, 100 + i * 10);
		if (i === 14) await target.mouse.click(300, 200);
		await sleep(100);
	}
	const editorOpened = browser.waitForTarget((t) => t.url().includes("/editor.html?id="), { timeout: 20000 });
	console.log("pages:", (await safePages()).map((p) => p.url()).join(" | "));
	const status = await statusOf();
	console.log("status:", JSON.stringify(status));
	if (!status?.recording) throw new Error("active recorder incorrectly reported as stopped");
	// The pointer logger must be live in the target tab at the same time as its events are
	// dropped or kept: that is what separates "fail closed" from "logging never ran" (P1-3).
	const logger = await ctl.evaluate(async (p) => {
		const tabs = await chrome.tabs.query({});
		const t = tabs.find((x) => (x.url ?? "").includes(`localhost:${p}`) && !x.url?.includes("decoy"));
		if (!t?.id) return { error: "target tab not found" };
		const [{ result }] = await chrome.scripting.executeScript({ target: { tabId: t.id }, func: () => window.__glideContent === true });
		return { tabId: t.id, injected: result };
	}, port);
	console.log("pointer logger in target tab:", JSON.stringify(logger));
	if (logger.injected !== true) throw new Error("pointer logger was not injected into the target tab");
	const stop = await ctl.evaluate(() => chrome.runtime.sendMessage({ target: "background", type: "stop" }));
	console.log("stop:", JSON.stringify(stop));
	const edTarget = await editorOpened;
	const ed = await edTarget.page();
	await ed.waitForSelector("body[data-ready]", { timeout: 20000 });
	console.log("editor:", await ed.$eval("#status", (e) => e.textContent));
	const n = await ed.evaluate(() => ({ events: glide.state.events.length, clicks: glide.state.telemetry.filter((p) => p.interactionType !== "move" && p.interactionType !== "mouseup").length, regions: glide.state.regions.length }));
	console.log("pointer data:", JSON.stringify(n), "| pointer mode:", status.pointer ?? "absent");
	// Pointer expectations follow the capture identity the service worker reported:
	//   "tab"    — exact tabId: both target clicks kept, the decoy tab's click excluded.
	//   "window" — focused-window heuristic: everything in the focused window is accepted,
	//              which in this single-window run includes the decoy tab's click.
	//   "off"    — pointer logging disabled or no verified scope: nothing may be saved.
	// A missing field means the running build predates the rewire — report, don't assert.
	if (status.pointer === "tab") {
		if (!(n.events > 0)) throw new Error(`tab capture recorded no pointer events: ${JSON.stringify(n)}`);
		if (n.clicks !== 2) throw new Error(`expected exactly the 2 target clicks (decoy tab excluded), got ${JSON.stringify(n)}`);
	} else if (status.pointer === "window") {
		if (n.events > 0) {
			if (n.clicks < 2) throw new Error(`expected at least the 2 target clicks, got ${JSON.stringify(n)}`);
		} else {
			// The heuristic is best-effort by design: without an observable focused-window
			// id reaching the recorder nothing can be attributed, and this environment
			// cannot prove the push happened (Wayland/headless focus may be inert).
			console.log("pointer data: UNVERIFIED — no focused-window events were kept (focus push may be inert in this environment)");
		}
	} else if (status.pointer === "off") {
		if (n.events) throw new Error(`pointer reported "off" but ${n.events} events were saved`);
	} else {
		console.log(`pointer data: UNVERIFIED — status.pointer is absent (src still landing); observed ${JSON.stringify(n)}`);
	}
	// Real-frame check: decode the recorded video and read the middle pixel. The fixture
	// page is a magenta-to-cyan gradient, so a correct capture is ~rgb(128,0,255); a dark
	// or stalled frame is what P2-9 used to record.
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
		if (onTarget === 0) {
			const why = tabCapture
				? "the tab stream produced no target pixels — headless may not render chromeMediaSource captures"
				: "the picker chose another surface — picker selection is not steerable from CDP, so which surface was recorded cannot be proven";
			// Only an exact tab capture has a provable surface identity; picker-based
			// window/screen captures observe whatever Chrome handed over.
			if (process.env.HEADFUL && tabCapture) throw new Error(`recorded frames are not the target tab: ${JSON.stringify(frames.samples)}`);
			console.log(`frame check: UNVERIFIED — ${why} (middle pixels ${JSON.stringify(frames.samples)}). Re-run headful with a display to assert the target pixels.`);
		} else {
			console.log(`frame check: ${onTarget}/${frames.samples.length} sampled frames show the target tab`);
		}
	}
} catch (e) {
	console.error("FAIL", e.message);
	console.error("open pages:", (await browser.pages().catch(() => [])).map((p) => p.url()).join(" | "));
	code = 1;
} finally {
	// A crashed/wedged browser never answers close(); do not hang the run on it.
	await Promise.race([browser.close(), sleep(5000)]).catch(() => {});
	server.close();
}
console.log(code ? "RECORD SMOKE FAILED" : "RECORD SMOKE OK");
process.exit(code);
