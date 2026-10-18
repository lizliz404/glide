# Glide

**A Screen Studio-style recorder that lives entirely in the browser.** Glide is a Chrome/Chromium MV3 extension that records a tab, the browser window or the whole screen with mic and webcam. Its editor is a browser port of **[Recordly](https://github.com/webadderallorg/Recordly)**, which gives you:

- Recordly's click-driven auto-zoom and edge-recentering follow camera, with its springs and timings.
- Wallpaper backgrounds and a padded squircle frame with a layered shadow.
- The Tahoe cursor with spring smoothing, click bounce and sway.
- The webcam bubble.

The motion engine is available for saved/imported telemetry and manual zoom edits. **Current recording limitation:** new captures discard pointer telemetry until Glide can verify which tab/window is captured; automatic click zooms and post-rendered cursor effects are therefore unavailable for new recordings. This prevents unrelated tabs' clicks from appearing in your video. Native cursor capture is browser-dependent. Manual zooms, framing, trimming and MP4/WebM exports still work. No native app, no account, nothing uploaded.

Why the browser: Chrome handles source selection, mic/camera permissions and Wayland portals. Single tab is the default; choose a browser window to record tab switches within that window.

> Status: v0.2, the Recordly port. Recording, editing and export work end to end. **[docs/STATUS.md](docs/STATUS.md)** covers what's done, the file-by-file list of what was copied from Recordly, design decisions, and the remaining gaps and warnings.
>
> Open issues from the latest QA/UX/PM pass on `3f5638b` (P1 should fix, P2 polish, with repro, screenshots and suggested fixes): **[docs/QA.md](docs/QA.md)**.

## Install on Arch / Omarchy

```bash
sudo pacman -S --needed chromium nodejs npm git     # or google-chrome / brave-bin from the AUR
git clone https://github.com/lizliz404/glide && cd glide
npm install
npm run build          # outputs ./dist
```

1. Open `chrome://extensions` (or `brave://extensions`).
2. Turn on **Developer mode** (top right).
3. Click **Load unpacked** and choose `glide/dist`.
4. Pin Glide from the puzzle-piece menu.

To update: `git pull && npm install && npm run build`, then click the reload icon on the Glide card.

- Tab capture needs no portal.
- Window or screen capture on Wayland goes through `xdg-desktop-portal`. Omarchy ships the Hyprland portal (`xdg-desktop-portal-hyprland`).
- Works the same on other Linux distros, Windows and macOS with Chrome, Chromium, Brave or Edge 116+.

## Use

1. Click the Glide icon. Choose **Tab** (recommended), **Browser window** or **Entire screen**, and toggle mic and webcam.
2. First run only: Glide may ask for mic/camera and optional site access. Pointer data is currently rejected because captured-source identity is not verified; granting site access does not restore auto-zoom.
3. Press **Record**. Tab/window mode opens a visible recorder page; press **Start recording** and choose the source in Chrome's share dialog. Keep the recorder open.
4. Stop from the Glide icon (or Chrome's **Stop sharing**). The editor opens with your recording; add manual zooms as needed.
5. Export with **Export MP4** (H.264 when the browser has an encoder, otherwise VP9) or **Export WebM** (VP9 + Opus). The file goes to Downloads.

### The editor

The editor has two sections, **Look** and **Motion**, plus a contextual Zoom panel and a full-width timeline. UI text uses self-hosted Geist Sans; timecodes and values use Geist Mono.

- **Look**: 38 static Recordly wallpapers + Upload Custom, three padding presets, shadow toggle, cursor and webcam controls. Browser-top crop is reversible for window/screen recordings and disabled for known single-tab recordings, which have no browser chrome. Aspect ratio sits under the preview. The upstream video wallpaper is not supported.
- **Motion**: Focused / Smooth presets, zoom defaults and Reset to defaults. Full internal settings remain backward compatible, but fine-tuning ranges are hidden.
- **Timeline**:
  - Purple blocks are zooms and white ticks are clicks. Click or drag the ruler to seek.
  - Drag a block to move it, or drag its edges to resize. Click a block to open the **Zoom** panel: Zoom Level (1.5× / 1.8× / 2.2×), Auto/Manual mode (in Manual, click the preview to set the focus point), and Delete Zoom.
  - **+ Zoom** adds a zoom at the playhead. **Suggest Zooms** re-runs Recordly's suggestions.
- Retain a range with **Set start / Set end / Reset trim**. Zooms, trim and browser-top choices persist per saved recording.
- Keys: **Space** play/pause, **←/→** seek, **Z** adds a zoom, **Delete** removes the selected zoom, **Esc** deselects. Native input/widget keys are preserved.

The editor also works without recording: **Open files** accepts any video, plus an optional webcam video (name containing `cam`) and an events JSON.

## Defaults (all Recordly's, nothing to tune)

| Area | Default | Recordly source |
| --- | --- | --- |
| Auto-zoom | Explicit clicks only. Clicks ≤ 2.5 s apart merge into one zoom, padded 500 ms on each side, aimed at the strongest click. Depth 3 = **1.8×**. Only for landscape sources (aspect ≥ 1.2). | `timeline/zoomSuggestionUtils.ts`, `hooks/useFreshRecordingAutoZoom.ts` |
| Zoom motion | Motion preset **Focused**: 200 ms in/out on Recordly's region-strength curve (`cubic-bezier(0.16,1,0.3,1)`), then a camera spring (smoothness 0.5; stiffness/damping/mass ×1 / ×1.13 / ×1.12). Connect Zooms on. Follow camera recenters when the cursor nears the edge (25% safe zone). The zoom moves the whole framed video; the background stays still. | `videoPlayback/zoomRegionUtils.ts`, `sceneMotion.ts`, `cursorFollowCamera.ts`, `motionSmoothing.ts`, `cursorMotionPresets.ts`, `lib/exporter/frameRenderer.ts` |
| Background | `tahoe-light.jpg`, blur 0 | `lib/wallpapers.ts` |
| Frame | Padding 20 (4% of the canvas per side), squircle radius **8%** of the short side, shadow 0.67 (three stacked drop-shadows) | `layoutUtils.ts`, `sceneEffects.ts`, `geometry/squircle.ts` |
| Cursor | Tahoe set, size 2.5, smoothing 0.67, spring ×1.35 / ×0.79 / ×1.29, click bounce 2 over 350 ms, sway 0.4, click effect off | `videoPlayback/cursorRenderer.ts`, `types.ts` |
| Webcam | **40%** of the short side, roundness 100 (squircle), shadow 0.3, 24 px margin, bottom-right, mirrored, shrinks while zoomed | `webcamOverlay.ts`, `lib/exporter/shadowProfile.ts` |
| Output | 16:9, 1920×1080, 30 fps | |

One deliberate deviation: Recordly uses an 8% radius only on macOS and 0 elsewhere. Glide uses 8% everywhere.

### Capture modes

| Mode | Cursor and zoom data | Notes |
| --- | --- | --- |
| Tab | Disabled until captured-tab identity is verified | Default; locks to the chosen tab, no browser chrome. |
| Browser window | Disabled until captured-window identity is verified | Records tab switches in that window and preserves real browser chrome for reversible crop. Native cross-tab pixels still need acceptance on this host. |
| Entire screen | Disabled until captured-source identity is verified | Includes other apps; cursor is browser-dependent and may be baked in. |

## Architecture

```
popup ──start──▶ service worker ──▶ offscreen document (DISPLAY_MEDIA + USER_MEDIA)
                    │                  getDisplayMedia + mic + webcam → 2× MediaRecorder (WebM)
                    │                  collects pointer events → IndexedDB
                    └─registers content script in all tabs (only while recording)
content script: pointer move/down/up + cursor shape ──runtime message──▶ offscreen
editor tab: IndexedDB → Mediabunny remux (seekable) → telemetry → Recordly zoom suggestions
            preview and export share one Compositor: SceneCamera → renderFrame (+ cursor, webcam)
            export: Mediabunny decode at exact timestamps → WebCodecs encode → MP4/WebM (no service worker involved)
```

- `src/background.ts`: orchestration, dynamic content-script registration, badge.
- `src/recorder.ts`: capture and recording (offscreen; `recorder.html?page` is a visible fallback).
- `src/content.ts`: pointer logger (moves, presses, CSS cursor shape mapped to Recordly cursor types). It never reads page content.
- `src/editor/telemetry.ts`: pointer log → Recordly `CursorTelemetryPoint[]`.
- `src/editor/camera.ts`: `suggestZoomRegions` + `SceneCamera` (Recordly's `updateAnimationState`).
- `src/editor/frame.ts`, `render.ts`: background, padded squircle frame, shadow, camera-transformed video layer.
- `src/editor/cursor.ts`, `webcam.ts`: Recordly cursor overlay and webcam bubble on Canvas 2D.
- `src/editor/compose.ts`: one compositor for preview and export. `settings.ts` composes the defaults. `main.ts` is the editor UI. `export.ts` is the frame-accurate export.
- `src/vendor/recordly/`: Recordly source, copied with per-file headers.

## What came from where

| Part | Source |
| --- | --- |
| Auto-zoom suggestions, zoom region timing and easing, follow camera, scene/zoom transform, springs, motion presets, padded layout, squircle, scene shadows, wallpaper fill, webcam overlay geometry and shadow, cursor renderer (smoothing, bounce, sway, click effects), cursor assets, 38 static wallpapers | **Copied from [Recordly](https://github.com/webadderallorg/Recordly) (AGPL-3.0) @ `e4a9d04`** into `src/vendor/recordly/`, Pixi/Electron/React parts removed. See `src/vendor/recordly/README.md`. |
| Defaults, editor layout, control labels and ranges, gradient and color presets | Mirrored from Recordly's `projectPersistence.ts`, `EditorShell.tsx`, `EditorSidebar.tsx`, `SettingsPanel.tsx` and `en/settings.json` |
| WebM demux, WebCodecs decode/encode, MP4/WebM mux, remux to seekable WebM | **[Mediabunny](https://mediabunny.dev)** (MPL-2.0, unmodified npm dependency) |
| Offscreen-document recording, tab-capture pattern | Chrome's official guide and samples (links below) |
| Extension wiring, recorder, pointer logging and coordinate mapping, browser glue (`src/editor/*`), editor DOM/CSS, export pipeline, tests | Written for Glide |

## Best practices followed

- MV3 media in an **offscreen document** with `DISPLAY_MEDIA`/`USER_MEDIA` reasons, no media in the service worker: [Audio recording and screen capture](https://developer.chrome.com/docs/extensions/how-to/web-platform/screen-capture), [chrome.offscreen](https://developer.chrome.com/docs/extensions/reference/api/offscreen), [Tab Capture recorder sample](https://github.com/GoogleChrome/chrome-extensions-samples/tree/main/functional-samples/sample.tabcapture-recorder).
- **Minimal permissions**: `offscreen`, `storage`, `scripting` only. Host access is an *optional* permission, requested at record time. The content script is registered only while recording and unregistered afterwards: [Declare permissions](https://developer.chrome.com/docs/extensions/develop/concepts/declare-permissions), [chrome.permissions](https://developer.chrome.com/docs/extensions/reference/api/permissions), [chrome.scripting.registerContentScripts](https://developer.chrome.com/docs/extensions/reference/api/scripting#method-registerContentScripts).
- **CSP**: default MV3 `script-src 'self'`; no inline scripts, no remote code: [MV3 CSP](https://developer.chrome.com/docs/extensions/reference/manifest/content-security-policy).
- Screen-share options set explicitly (`surfaceSwitching`, `selfBrowserSurface`, `systemAudio`, `monitorTypeSurfaces`): [Privacy-preserving screen sharing controls](https://developer.chrome.com/docs/web-platform/screen-sharing-controls). Spec for `cursor` constraint: [Screen Capture](https://w3c.github.io/mediacapture-screen-share/).
- Recording with `MediaRecorder` and timeslices, codec picked by `isTypeSupported`: [MDN MediaRecorder](https://developer.mozilla.org/docs/Web/API/MediaRecorder).
- Export through **WebCodecs** with encoder feature detection and fallback (`getFirstEncodableVideoCodec`), with backpressure respected by awaiting `add()`: [Mediabunny guide](https://mediabunny.dev/guide/introduction), [WebCodecs](https://developer.chrome.com/docs/web-platform/best-practices/webcodecs).
- Large media handed between extension pages through IndexedDB Blobs, not runtime messages.
- **Export never depends on the service worker.** Chrome stops an idle MV3 worker after about 30 s ([extension service worker lifecycle](https://developer.chrome.com/docs/extensions/develop/concepts/service-workers/lifecycle)). Glide's export runs entirely in the editor tab (WebCodecs and Mediabunny on an `OffscreenCanvas`) and never messages the worker, so multi-minute exports can't be cut off. The tests wake the worker the way a user does (opening the popup) rather than assuming it is still alive.
- Accessibility: labelled native controls; the sidebar is a `tablist` with arrow-key roving focus; option groups are `radiogroup`s; the timeline is a keyboard `slider` (←/→, Shift for 5 s); zoom blocks are focusable buttons (Enter selects, Delete removes); `aria-live` status; visible focus rings; `prefers-reduced-motion` respected in the UI.

## What is tested

`npm run test:unit` (Vitest, 23 files): Recordly's own unit tests for the copied modules (zoom suggestions, zoom animation, follow camera, scene motion, layout, scene effects, webcam overlay and shadow, cursor scale/sway/viewport/motion sampling/assets), plus Glide tests for telemetry → regions, the camera, frame layout, the cursor layer, the webcam bubble, and the composed defaults.

`npm test` (headless Chrome, Puppeteer):
- The extension installs, the service worker wakes from the popup, the editor page renders, the footer carries the Recordly attribution, and no option is labelled "Recordly".
- The editor loads a synthetic 12 s recording (fake screen + webcam + 731 pointer events; clicks at 2.0, 2.8, 6.5 and 9.5 s). That gives exactly **3 auto zooms** (1.5–3.3 s, 6–7 s, 9–10 s; depth 3, mode auto), and the camera reaches 1.8× mid-zoom.
- **Exports MP4 (H.264 + Opus) and WebM (VP9 + Opus), 1920×1080, 360 frames, 12.0 s**, verified with `ffprobe`.

`npm run test:record` (headful Chrome under Xvfb, fake mic/cam): popup → recorder → capture → stop → IndexedDB → editor. The source-scope guard now requires zero retained events for unverified sources. Page-mode smoke decodes frames; headful mode asserts target pixels, while headless mode explicitly reports target identity unverified. The earlier smoke captured the recorder itself and was not target-tab evidence.

Not covered automatically: tab capture (Chrome's auto-select flag for tabs doesn't work on the CI box), the permission prompts, and real webcam/mic hardware.

## Limitations

- **Not ported:** zoom/cursor motion blur (needs Pixi/WebGL), device frames, captions, annotations, general crop, unlinked padding, interior cuts and speed edits. Start/end trim and reversible browser-top crop are implemented.
- **New captures have no click-driven zooms or drawn cursor.** Unknown source identity rejects all pointer events; a verified native identity path remains follow-up work. No extra capture permission has been added.
- Saved recording zooms, trim and browser-top choices persist locally; raw imports have no durable recording identity. There is no undo stack yet.
- Export speed depends on hardware video encode. On the CPU-only CI box, 12 s of 1080p takes about 3 minutes per container. A desktop GPU is much faster.
- Chrome on Linux has no AAC encoder in WebCodecs, so MP4 audio is Opus. If an editor such as CapCut rejects it: `ffmpeg -i in.mp4 -c:v copy -c:a aac out.mp4`.
- Some Chromium builds lack an H.264 encoder. Glide then writes VP9 in MP4 and says so in the status line.
- The bundled wallpapers and cursors are Apple- and Microsoft-derived artwork that Recordly ships without a license. This repo is public, so that's a live copyright risk: replace them with CC0 or self-made assets (see `THIRD_PARTY_NOTICES.md` and `docs/STATUS.md`).

## Roadmap

Restore source-verified pointer capture · interior cuts · general crop · port zoom and cursor motion blur · 60 fps export · keystroke overlay · teleprompter overlay (like Excalicord) · auto-captions.

## References

Inspiration and prior art (checked 2026-10-17; ★ = GitHub stars):

- [Excalicord](https://www.excalicord.com/): Zara Zhang's Excalidraw whiteboard + webcam recorder (browser). Its corner-webcam and teleprompter idea inspired the browser-only approach.
- [excalicord-plus](https://github.com/goking81/excalicord-plus): whiteboard, slides, screen/window and picture-in-picture recording in the browser (no license file).
- [OpenScreen](https://github.com/siddharthvaddem/openscreen): ★39.9k, MIT, Electron. Recordly started as a fork of it.
- [Recordly](https://github.com/webadderallorg/Recordly): ★34.2k, AGPL-3.0, Electron. **Glide's editor is a port of it.**
- [Cap](https://github.com/CapSoftware/Cap): ★23.4k, AGPL-3.0 (parts MIT), native Loom alternative.
- [Screenity](https://github.com/alyssaxuu/screenity): ★18.8k, GPL-3.0, Chrome extension recorder. Zoom keyframes are in the paid Pro version.
- [Mediabunny](https://github.com/Vanilagy/mediabunny): ★7.3k, MPL-2.0, media toolkit used for export.
- [Focal](https://github.com/barboravigasova27/focal-studio): Chrome extension with tab capture and spring zoom (no license).
- [Cursorful](https://cursorful.com/), [Zumie](https://zumie.io/), [Screenhance](https://screenhance.com/), [Tella](https://www.tella.com/features/zoom): commercial extensions with click auto-zoom.
- [Screenix](https://screenix.studio/): commercial Linux desktop recorder with auto-zoom ($39/yr or $59 lifetime).
- [Screen Studio](https://screen.studio/): the macOS original.

## License

**AGPL-3.0** (see [LICENSE](LICENSE)). Glide contains code derived from Recordly, whose license is AGPL-3.0 with two extra terms: credit Recordly in the UI and the repo, and don't use its name or branding. The editor footer reads "Based on Recordly (AGPL-3.0)", and Glide is not branded as Recordly. Full attribution and asset notes are in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
