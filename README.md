# Glide

**A Screen Studio-style recorder that lives entirely in the browser.** Chrome/Chromium MV3 extension: record a tab, the browser window or the whole screen with mic and webcam, then get the polished look (gradient or image background, padded rounded frame with shadow, smooth auto-zoom that follows your clicks and cursor, redrawn smooth cursor with click ripples, webcam bubble) and export MP4 or WebM. No native app, no account, nothing uploaded.

Why the browser: picking screens/windows, mic and camera permissions, and Wayland portals are the painful part of native recorders on Linux and Windows. Chrome already solves all of that with one share dialog. If what you are demoing is a web page or a `localhost` app, a tab is all you need, and in a tab the extension sees every click precisely.

> Status: MVP (v0.1). Recording, editing and export work end to end; see [What is tested](#what-is-tested) and [Limitations](#limitations).

## Install (load unpacked)

Works in Chromium, Google Chrome, Brave and Edge 116+ on Linux, Windows and macOS.

```bash
git clone https://github.com/lizliz404/glide && cd glide
npm install
npm run build          # outputs ./dist
```

1. Open `chrome://extensions`.
2. Turn on **Developer mode** (top right).
3. Click **Load unpacked** and choose the `glide/dist` folder.
4. Pin Glide from the puzzle-piece menu.

After pulling new code: `npm run build`, then click the reload icon on the Glide card in `chrome://extensions`.

Arch / Omarchy: `sudo pacman -S --needed chromium nodejs npm` is enough. Tab capture needs no portal. Window or screen capture on Wayland goes through `xdg-desktop-portal` (Omarchy ships the Hyprland portal).

## Use

1. Click the Glide icon. Choose **Tab** (recommended), **Browser window** or **Entire screen**. Toggle mic and webcam.
2. First run only: Glide opens a page asking for mic and camera access. Recording runs in a hidden offscreen page that cannot show prompts, so the grant has to happen once on a visible page. Chrome then asks for **site access**. That lets Glide log pointer positions while recording; it is what powers auto-zoom and the smooth cursor.
3. Press **Record** and pick the source in Chrome's share dialog. In tab mode, Chrome's bar has **Share this tab instead**, so you can move the recording to another tab mid-take.
4. Stop from the Glide icon (or Chrome's **Stop sharing**). The editor opens with your recording.
5. Adjust background, padding, radius, shadow, zoom scale/trigger/hold, cursor and webcam. **Space** plays and pauses. Blue blocks on the timeline are zooms; white ticks are clicks.
6. **Export MP4** (H.264 when the browser has an encoder, otherwise VP9) or **Export WebM** (VP9 + Opus). The file goes to your Downloads folder.

The editor also works without recording: **Open files** accepts any video, plus an optional webcam video (name containing `cam`) and an events JSON.

### Capture modes

| Mode | Cursor and zoom data | Notes |
| --- | --- | --- |
| Tab | Exact (viewport coordinates) | No OS cursor in the frames, so Glide draws a smooth one. Use "Share this tab instead" to switch tabs. |
| Browser window | Approximate (window box from `screenX/outerWidth`) | Records every tab you switch to. The OS cursor is baked in, so smooth cursor is off by default. |
| Entire screen | Approximate, single monitor | Clicks outside the browser are not seen. Browsers do not expose them, the same limit Cursorful and Zumie document. |

## Architecture

```
popup ──start──▶ service worker ──▶ offscreen document (DISPLAY_MEDIA + USER_MEDIA)
                    │                  getDisplayMedia + mic + webcam → 2× MediaRecorder (WebM)
                    │                  collects pointer events → IndexedDB
                    └─registers content script in all tabs (only while recording)
content script: pointer move/down/up + timestamps ──runtime message──▶ offscreen
editor tab: IndexedDB → Mediabunny remux (seekable) → canvas preview
            export: Mediabunny decode at exact timestamps → same compositor → WebCodecs encode → MP4/WebM
```

- `src/background.ts`: orchestration, dynamic content-script registration, badge.
- `src/recorder.ts`: capture and recording (offscreen; `recorder.html?page` is a visible fallback).
- `src/content.ts`: pointer logger. Never reads page content.
- `src/editor/camera.ts`: zoom policy (click clustering) driving the vendored OpenScreen motion code.
- `src/editor/render.ts`: one compositor shared by preview and export, so the export matches the preview.
- `src/editor/export.ts`: frame-accurate export (faster than real time on a GPU machine; no dropped frames).

## What came from where

| Part | Source |
| --- | --- |
| Zoom camera spring, cursor spring, frame-rate independent cursor follow, easing curves | **Vendored from [OpenScreen](https://github.com/siddharthvaddem/openscreen) (MIT) @ `ca8104c`**, unchanged. See `src/vendor/openscreen/README.md`. |
| WebM demux, WebCodecs decode/encode, MP4/WebM mux, remux to seekable WebM | **[Mediabunny](https://mediabunny.dev)** (MPL-2.0, unmodified npm dependency) |
| Spring generator used by OpenScreen's code | **[Motion](https://motion.dev)** (MIT) |
| Offscreen-document recording, tab-capture pattern | Chrome's official guide and samples (links below) |
| Two-click zoom trigger option | Idea from Cursorful's FAQ (it reduces motion sickness) |
| Extension wiring, recorder, pointer logging and coordinate mapping, zoom policy, compositor, editor UI, export pipeline, tests | Written for Glide |

Why not fork a whole recorder: [Screenity](https://github.com/alyssaxuu/screenity) (the best open browser recorder) is GPL-3.0. [Recordly](https://github.com/webadderallorg/Recordly) and [Cap](https://github.com/CapSoftware/Cap) are AGPL-3.0, and Focal has no license. A fork would force those licenses onto this MIT repo. OpenScreen is MIT but an Electron app, so only its pure-TypeScript motion code was taken.

## Best practices followed

- MV3 media in an **offscreen document** with `DISPLAY_MEDIA`/`USER_MEDIA` reasons, no media in the service worker: [Audio recording and screen capture](https://developer.chrome.com/docs/extensions/how-to/web-platform/screen-capture), [chrome.offscreen](https://developer.chrome.com/docs/extensions/reference/api/offscreen), [Tab Capture recorder sample](https://github.com/GoogleChrome/chrome-extensions-samples/tree/main/functional-samples/sample.tabcapture-recorder).
- **Minimal permissions**: `offscreen`, `storage`, `scripting` only. Host access is an *optional* permission, requested at record time. The content script is registered only while recording and unregistered afterwards: [Declare permissions](https://developer.chrome.com/docs/extensions/develop/concepts/declare-permissions), [chrome.permissions](https://developer.chrome.com/docs/extensions/reference/api/permissions), [chrome.scripting.registerContentScripts](https://developer.chrome.com/docs/extensions/reference/api/scripting#method-registerContentScripts).
- **CSP**: default MV3 `script-src 'self'`; no inline scripts, no remote code: [MV3 CSP](https://developer.chrome.com/docs/extensions/reference/manifest/content-security-policy).
- Screen-share options set explicitly (`surfaceSwitching`, `selfBrowserSurface`, `systemAudio`, `monitorTypeSurfaces`): [Privacy-preserving screen sharing controls](https://developer.chrome.com/docs/web-platform/screen-sharing-controls). Spec for `cursor` constraint: [Screen Capture](https://w3c.github.io/mediacapture-screen-share/).
- Recording with `MediaRecorder` and timeslices, codec picked by `isTypeSupported`: [MDN MediaRecorder](https://developer.mozilla.org/docs/Web/API/MediaRecorder).
- Export through **WebCodecs** with encoder feature detection and fallback (`getFirstEncodableVideoCodec`), with backpressure respected by awaiting `add()`: [Mediabunny guide](https://mediabunny.dev/guide/introduction), [WebCodecs](https://developer.chrome.com/docs/web-platform/best-practices/webcodecs).
- Large media handed between extension pages through IndexedDB Blobs, not runtime messages.
- Accessibility: native form controls with labels, `aria-live` status, `aria-pressed` on Play, visible focus rings, keyboard play/pause, `prefers-reduced-motion` respected in UI.

## What is tested

`npm test` (headless Chrome, Puppeteer):
- builds; editor loads a synthetic 12 s recording (fake screen + fake webcam + 731 pointer events); 4 clicks → 2 zoom segments;
- **exports MP4 (H.264 + Opus) and WebM (VP9 + Opus), 1920×1080, 360 frames, 12.0 s**, verified with `ffprobe`;
- extension installs, service worker starts, popup and editor render.

`npm run test:record` (headful Chrome under Xvfb, fake mic/cam):
- real path: popup → service worker → offscreen `getDisplayMedia` (screen) + mic + webcam → stop → IndexedDB → editor opens with **pointer events and a click captured from a real page via the content script**.

Not covered automatically: tab capture (Chrome's auto-select flag for tabs does not work in this CI box), the permission prompts, and real webcam/mic hardware.

## Limitations

- Window/screen modes map pointer coordinates approximately (window frame, multi-monitor). Tab mode is exact.
- Pointer data only exists for pages the content script can run on: not `chrome://` pages, the Web Store, or other apps.
- No trim/cut, no manual zoom editing yet (zooms come from clicks; tune with scale/trigger/hold).
- Export speed depends on hardware video encode. On a CPU-only VM, 12 s of 1080p took about 100 s. Expect much faster on a desktop GPU.
- Chrome on Linux has no AAC encoder in WebCodecs, so MP4 audio is Opus. Most players handle it. If an editor such as CapCut rejects it: `ffmpeg -i in.mp4 -c:v copy -c:a aac out.mp4`.
- Some Chromium builds lack an H.264 encoder. Glide then writes VP9 in MP4 and says so in the status line.

## Roadmap

Trim and cut on the timeline · drag-to-edit zoom blocks · 60 fps export option · keystroke overlay · teleprompter overlay (like Excalicord) · 3:4 whiteboard mode · per-segment webcam layouts · auto-captions via talkcut.

## References

Inspiration and prior art (checked 2026-10-17; ★ = GitHub stars):

- [Excalicord](https://www.excalicord.com/): Zara Zhang's Excalidraw whiteboard + webcam recorder (browser). Its corner-webcam and teleprompter idea inspired the browser-only approach.
- [excalicord-plus](https://github.com/goking81/excalicord-plus): whiteboard, slides, screen/window and picture-in-picture recording in the browser (no license file).
- [OpenScreen](https://github.com/siddharthvaddem/openscreen): ★39.9k, MIT, Electron. Source of Glide's motion code.
- [Recordly](https://github.com/webadderallorg/Recordly): ★34.2k, AGPL-3.0, Electron, auto-zoom.
- [Cap](https://github.com/CapSoftware/Cap): ★23.4k, AGPL-3.0 (parts MIT), native Loom alternative.
- [Screenity](https://github.com/alyssaxuu/screenity): ★18.8k, GPL-3.0, Chrome extension recorder. Zoom keyframes are in the paid Pro version.
- [Mediabunny](https://github.com/Vanilagy/mediabunny): ★7.3k, MPL-2.0, media toolkit used for export.
- [Focal](https://github.com/barboravigasova27/focal-studio): Chrome extension with tab capture and spring zoom (no license).
- [Cursorful](https://cursorful.com/), [Zumie](https://zumie.io/), [Screenhance](https://screenhance.com/), [Tella](https://www.tella.com/features/zoom): commercial extensions with click auto-zoom.
- [Screenix](https://screenix.studio/): commercial Linux desktop recorder with auto-zoom ($39/yr or $59 lifetime).
- [Screen Studio](https://screen.studio/): the macOS original.

## License

MIT for Glide's own code. Vendored and bundled third-party code keeps its license; see [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
