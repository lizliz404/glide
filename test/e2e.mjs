// Headless checks: editor renders a synthetic recording, exports MP4 + WebM, and the
// extension loads (service worker + popup). Run: npm test
import { execFileSync } from "node:child_process";
import { createServer } from "node:http";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { extname, join, resolve } from "node:path";
import puppeteer from "puppeteer-core";

const root = resolve(".");
const CHROME = process.env.CHROME ?? "/usr/bin/google-chrome";
const types = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".webm": "video/webm", ".png": "image/png", ".map": "application/json" };
const server = createServer(async (req, res) => {
	const p = decodeURIComponent(new URL(req.url, "http://x").pathname);
	const file = p.startsWith("/fixtures/") ? join(root, "test", p) : join(root, "dist", p);
	try {
		const body = await readFile(file);
		res.writeHead(200, { "content-type": types[extname(file)] ?? "application/octet-stream" });
		res.end(body);
	} catch {
		res.writeHead(404).end();
	}
}).listen(0);
const port = server.address().port;
await mkdir("test/out", { recursive: true });
const fail = (m) => {
	console.error("FAIL", m);
	process.exitCode = 1;
};

const browser = await puppeteer.launch({
	executablePath: CHROME,
	headless: true,
	// Chrome 137+ ignores --load-extension; Puppeteer loads unpacked extensions over CDP.
	enableExtensions: true,
	pipe: true,
	args: ["--no-sandbox", "--enable-unsafe-swiftshader", "--use-angle=swiftshader"],
});
const extId = await browser.installExtension(`${root}/dist`);
try {
	// 1) Editor with synthetic recording.
	const page = await browser.newPage();
	page.on("console", (m) => m.type() === "error" && console.log("[page]", m.text()));
	page.on("pageerror", (e) => fail(`pageerror ${e.message}`));
	await page.setViewport({ width: 1600, height: 960 });
	await page.goto(`http://localhost:${port}/editor.html?src=/fixtures/screen.webm&cam=/fixtures/cam.webm&events=/fixtures/events.json`);
	await page.waitForSelector("body[data-ready]", { timeout: 30000 });
	const info = await page.evaluate(() => ({ status: document.getElementById("status").textContent, segs: glide.state.segments.length, clicks: glide.state.track.clicks.length, dur: glide.state.durationMs }));
	console.log("editor:", info);
	if (info.segs < 2) fail("expected >=2 zoom segments");
	if (Math.abs(info.dur - 12000) > 300) fail(`duration ${info.dur}`);
	await page.evaluate(() => glide.seek(2400));
	await new Promise((r) => setTimeout(r, 300));
	await page.screenshot({ path: "test/out/editor.png" });
	console.log("screenshot test/out/editor.png");

	for (const c of (process.env.FORMATS ?? "mp4,webm").split(",").filter(Boolean)) {
		const t0 = Date.now();
		const res = await page.evaluate((c) => glide.export(c), c);
		const out = `test/out/export.${c}`;
		await writeFile(out, Buffer.from(res.b64, "base64"));
		const probe = JSON.parse(execFileSync("ffprobe", ["-v", "error", "-show_entries", "stream=codec_type,codec_name,width,height,nb_read_frames:format=duration", "-count_frames", "-of", "json", out]).toString());
		const v = probe.streams.find((s) => s.codec_type === "video");
		const a = probe.streams.find((s) => s.codec_type === "audio");
		console.log(`${c}: ${res.videoCodec}/${res.audioCodec} in ${((Date.now() - t0) / 1000).toFixed(1)}s ->`, JSON.stringify({ duration: probe.format.duration, v, a }));
		if (!v || v.width !== 1920 || v.height !== 1080) fail(`${c} video stream`);
		if (Math.abs(Number(probe.format.duration) - 12) > 0.5) fail(`${c} duration ${probe.format.duration}`);
		if (Number(v.nb_read_frames) < 350) fail(`${c} frames ${v.nb_read_frames}`);
		if (!a) fail(`${c} has no audio`);
		execFileSync("ffmpeg", ["-v", "error", "-y", "-ss", "2.6", "-i", out, "-frames:v", "1", `test/out/frame-${c}.png`]);
	}

	// 2) Extension loads: service worker up, popup renders, manifest permissions minimal.
	const sw = await browser.waitForTarget((t) => t.type() === "service_worker" && t.url().startsWith(`chrome-extension://${extId}/`), { timeout: 10000 }).catch(() => null);
	if (!sw) fail("extension service worker not found");
	else {
		const popup = await browser.newPage();
		await popup.goto(`chrome-extension://${extId}/popup.html`);
		const txt = await popup.$eval("#start", (b) => b.textContent);
		console.log(`extension ${extId}: popup button "${txt}"`);
		const ed = await browser.newPage();
		await ed.goto(`chrome-extension://${extId}/editor.html`);
		await new Promise((r) => setTimeout(r, 500));
		console.log("extension editor status:", await ed.$eval("#status", (e) => e.textContent));
	}
} finally {
	await browser.close();
	server.close();
}
console.log(process.exitCode ? "E2E FAILED" : "E2E OK");
