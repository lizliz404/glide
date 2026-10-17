// Headless checks: the extension loads (service worker + popup + editor page), the editor renders a
// synthetic recording with Recordly-style auto zooms, and MP4 + WebM exports are valid (ffprobe).
// Run: npm test   (FORMATS=mp4 to export one container; SHOTS=dir to also copy screenshots there)
import { execFileSync } from "node:child_process";
import { createServer } from "node:http";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { extname, join, resolve } from "node:path";
import puppeteer from "puppeteer-core";

const root = resolve(".");
const CHROME = process.env.CHROME ?? "/usr/bin/google-chrome";
const types = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".webm": "video/webm", ".png": "image/png", ".jpg": "image/jpeg", ".svg": "image/svg+xml", ".map": "application/json" };
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
	// A 1080p export takes minutes on a CPU-only box; don't let CDP time out the evaluate() call.
	protocolTimeout: 30 * 60 * 1000,
	args: ["--no-sandbox", "--enable-unsafe-swiftshader", "--use-angle=swiftshader"],
});
const extId = await browser.installExtension(`${root}/dist`);
try {
	// 1) Extension. MV3 service workers are event-driven and Chrome stops them after ~30 s idle, so
	// the check wakes the worker the way users do (the popup messages it) instead of assuming it
	// is still alive minutes later.
	const popup = await browser.newPage();
	await popup.goto(`chrome-extension://${extId}/popup.html`);
	const txt = await popup.$eval("#start", (b) => b.textContent);
	const sw = await browser.waitForTarget((t) => t.type() === "service_worker" && t.url().startsWith(`chrome-extension://${extId}/`), { timeout: 15000 }).catch(() => null);
	if (!sw) fail("extension service worker not found after waking it from the popup");
	console.log(`extension ${extId}: service worker ${sw ? "up" : "MISSING"}, popup button "${txt}"`);
	const ed = await browser.newPage();
	await ed.goto(`chrome-extension://${extId}/editor.html`);
	await new Promise((r) => setTimeout(r, 800));
	console.log("extension editor status:", await ed.$eval("#status", (e) => e.textContent));
	const footer = await ed.$eval(".credit", (e) => e.textContent);
	if (!/Based on Recordly \(AGPL-3\.0\)/.test(footer)) fail(`missing Recordly attribution footer: ${footer}`);
	const labels = await ed.$$eval("option, [role=radio], [role=tab], label", (els) => els.map((e) => e.textContent.trim()).filter((t) => /recordly/i.test(t)));
	if (labels.length) fail(`"Recordly" used as an option label: ${labels}`);
	await Promise.all([popup.close(), ed.close()]);

	// 2) Editor with the synthetic recording (dev URL, plain http).
	const page = await browser.newPage();
	page.on("console", (m) => m.type() === "error" && console.log("[page]", m.text()));
	page.on("pageerror", (e) => fail(`pageerror ${e.message}`));
	await page.setViewport({ width: 1600, height: 960 });
	await page.goto(`http://localhost:${port}/editor.html?src=/fixtures/screen.webm&cam=/fixtures/cam.webm&events=/fixtures/events.json`);
	await page.waitForSelector("body[data-ready]", { timeout: 60000 });
	const info = await page.evaluate(() => ({
		status: document.getElementById("status").textContent,
		regions: glide.state.regions.map((r) => ({ startMs: r.startMs, endMs: r.endMs, depth: r.depth, mode: r.mode, focus: r.focus })),
		dur: glide.state.durationMs,
		blocks: document.querySelectorAll(".zoom-block").length,
	}));
	console.log("editor:", JSON.stringify(info));
	// Fixture clicks at 2.0 s + 2.8 s (merged: gap <= 2500 ms), 6.5 s and 9.5 s -> 3 regions, 500 ms pad, depth 3.
	if (info.regions.length !== 3) fail(`expected 3 auto zoom regions, got ${info.regions.length}`);
	if (info.blocks !== info.regions.length) fail("timeline blocks != regions");
	if (info.regions.some((r) => r.depth !== 3 || r.mode !== "auto")) fail("auto regions should be depth 3 / mode auto");
	if (info.regions[0] && Math.abs(info.regions[0].startMs - 1500) > 50) fail(`first region should start 500 ms before the 2.0 s click, got ${info.regions[0].startMs}`);
	if (Math.abs(info.dur - 12000) > 300) fail(`duration ${info.dur}`);

	const r0 = info.regions[0] ?? { startMs: 1500, endMs: 3300 };
	const midMs = Math.round((r0.startMs + r0.endMs) / 2);
	await page.evaluate((ms) => glide.seek(ms), midMs);
	await new Promise((r) => setTimeout(r, 400));
	const cam = await page.evaluate(() => glide.camera());
	console.log(`camera at ${midMs} ms:`, JSON.stringify(cam));
	if (!(cam.scale > 1.6)) fail(`expected ~1.8x zoom mid-region, got ${cam.scale}`);
	await page.evaluate(() => glide.selectRegion(glide.state.regions[0]?.id ?? null));
	await new Promise((r) => setTimeout(r, 200));
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
		execFileSync("ffmpeg", ["-v", "error", "-y", "-ss", String(midMs / 1000), "-i", out, "-frames:v", "1", `test/out/frame-${c}.png`]);
		execFileSync("ffmpeg", ["-v", "error", "-y", "-ss", "0.5", "-i", out, "-frames:v", "1", `test/out/frame0-${c}.png`]);
	}
	if (process.env.SHOTS) {
		await copyFile("test/out/editor.png", join(process.env.SHOTS, "glide-editor-v2.png"));
		const first = (process.env.FORMATS ?? "mp4,webm").split(",")[0];
		await copyFile(`test/out/frame-${first}.png`, join(process.env.SHOTS, "glide-export-frame.png")).catch(() => {});
	}
} finally {
	await browser.close();
	server.close();
}
console.log(process.exitCode ? "E2E FAILED" : "E2E OK");
