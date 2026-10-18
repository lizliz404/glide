# Glide status

Last updated 2026-10-18 (Asia/Shanghai), at `main` after the Recordly port (v0.2).

Glide is a Chrome MV3 extension that records a tab, window or screen with mic and webcam. Its editor is a browser port of [Recordly](https://github.com/webadderallorg/Recordly) (AGPL-3.0), copied from commit **`e4a9d04860f4cbad3358bda3ac4a2307489f1d03`** (2026-10-17). This page records what's done, what was copied from where, what we decided and why, and what's still missing.

## QA corrections (2026-10-18)

- Default returns to **Single tab**; window capture remains an explicit option. Surface hints update with the selected mode; status no longer exposes raw capture IDs.
- **Pointer-scope safety trade-off:** new recordings discard all pointer events while captured-source identity is unknown. This prevents cross-tab contamination but temporarily removes automatic zooms and post-rendered cursor effects from new recordings. Existing telemetry/manual zoom editing remains available. Restoring verified tab/window identity is open; no manifest permissions were added.
- Editor has **Look / Motion**, fewer visible controls, offline Geist Sans/Mono, accessible filled-button colours, 19 of the 38 upstream wallpapers and Upload Custom. Upstream `wispysky.mp4` remains unsupported. Third-party artwork rights remain unresolved; see `THIRD_PARTY_NOTICES.md`.
- Single-tab recordings cannot crop page content with Browser top, including old saved `hideTop:true` projects. Window-source crop remains reversible and recording-scoped.
- Missing media disables export/trim/zoom actions and shows recovery copy. Export disables duplicate export and file import; cancellation is not labelled failure. Shortcut hints, Z and global arrow seek restored.
- Integration checks: 195 tests in 23 files, typecheck/build, browser recording-scoped persistence, and immediate export cancellation/import-export locking pass. Persistence covers two-section UI, old tab-crop guard, window crop/reload, imports and bad-ID recovery. The page-mode smoke no longer auto-accepts the recorder as its own source; headless target pixels remain explicitly unverified. No new native-window/cross-tab or physical-device acceptance claim.

## Earlier editing and capture additions (2026-10-18)

These changes are included in this source revision; this is not a deployment or release receipt.

- This earlier iteration recommended Window; the QA correction above restores Single tab as default. Window and single-tab modes start from a visible recorder page. Chrome's picker remains authoritative: selecting a single tab still locks capture to that tab.
- **Scene → Browser top → Hide browser top in export** is an independent, reversible per-recording edit. Adjust **Top height** in source-video pixels to remove the tab strip, address bar and toolbar. Preview and export share Recordly's existing crop-layout path; original media/zoom coordinates remain intact. A content-only recording cannot restore absent browser chrome. The current height is constant for the recording, not automatic detection of changing browser layouts/fullscreen.
- Per-recording zoom edits, retained start/end, and browser-top presentation survive reload in localStorage. Raw imports have no stable project identity and do not overwrite saved recording edits. No IndexedDB schema change.
- MP4/WebM trimming preserves source-time screen/webcam/cursor/zoom synchronization, rebases output timestamps, and clips boundary PCM samples. Static blurred backgrounds are cached; no proven overall export speedup.
- Visible recorder reuse/status/stop handling improved. Do not use active-tab state as proof that a recorder owns an active recording.

Verification of these additions: 188 unit tests pass; typecheck/build pass; browser editor reload/trim/browser-top isolation passes; visible single-tab recording/reuse/save/editor passes with fake devices. A synthetic top-band source was actually exported to MP4 with the band present, absent after crop, and restored in preview. Native window-follow acceptance is **not yet verified**: an isolated X11 Chromium window-selection probe timed out; the fake-media test does not count as proof of real cross-tab window pixels. No user-monitor capture was used as a substitute.

The sections below describe the original Recordly port unless noted.

Contents: [Done](#done) · [Copied from Recordly](#copied-from-recordly-file-by-file) · [Design decisions](#design-decisions-and-what-we-learned) · [Defaults](#defaults) · [Gaps, todos and warnings](#gaps-todos-and-warnings)

## Done

| Step | Commits | Result |
| --- | --- | --- |
| MVP | `1850c0c`, `59e82c7`, `cebd913` | Recording pipeline (offscreen document, `getDisplayMedia` + mic + webcam, MediaRecorder WebM, pointer logging via a content script registered only while recording, IndexedDB handoff), canvas editor, frame-accurate WebCodecs export through Mediabunny, headless tests. Motion code was then vendored from OpenScreen (MIT). That vendoring is now removed. |
| Port foundation (P0) | `bda7686` | Recordly's shared types, springs, easing, presets and squircle vendored into `src/vendor/recordly/`; Vitest added. |
| P1 zoom / cursor-focus | `0f04ee9` → merge `11d6daa` | Recordly's click-driven zoom suggestions, zoom region timing, connected zooms, edge-recentering follow camera, and a spring camera that transforms the whole video layer. |
| P2 background + frame + shadow | `9d9c677` → merge `78874df` | 5 Recordly wallpapers, padded layout, squircle mask, three stacked drop-shadows, background blur. |
| P3 webcam bubble | `e49114a` → merge `4ffae8c` | Recordly's webcam geometry (size, position presets, margin, reacts to zoom), squircle clip, mirror, shadow. |
| P4 cursor | `f0d539d` → merge `ac76c34` | Recordly's cursor renderer on Canvas 2D: Tahoe / Golden Gate assets, spring smoothing, click bounce, sway, click effects. |
| P5 wiring + UI | `89a196b` | One compositor for preview and export. Combined defaults. Recordly-style editor (header, icon rail Scene/Cursor/Webcam/Settings, preview, timeline with editable zoom blocks, Zoom panel). Legacy OpenScreen code and the `motion` dependency removed. |
| License | `bf3d025` | Relicensed to AGPL-3.0. Recordly attribution in README, THIRD_PARTY_NOTICES and the editor footer ("Based on Recordly (AGPL-3.0)"). |

Verified at `bf3d025`:

- `tsc`: clean.
- `npm run test:unit`: 18 files, 148 tests.
- `npm test`:
  - 3 auto zooms for the fixture's 4 clicks, and the camera reaches 1.8× mid-zoom.
  - MP4 h264/opus and WebM vp9/opus, 1920×1080, 360 frames, 12.02 s, checked with ffprobe.
  - The service worker wakes from the popup.
  - The attribution footer is present, and no option is labelled "Recordly".
- `npm run test:record`: a real screen recording through popup → service worker → offscreen document → editor captured pointer events and a click.

## Copied from Recordly (file by file)

Upstream paths are relative to the Recordly repo at `e4a9d04`. `E/` = `src/components/video-editor/`. Every copied file starts with a header giving its upstream path and the exact changes.

### Source (`src/vendor/recordly/`)

| Glide file | Recordly source @ `e4a9d04` | Changes |
| --- | --- | --- |
| `types.ts` | `E/types.ts` | Removed the Electron-only `audioTypes` type re-export |
| `mathUtils.ts` | `E/videoPlayback/mathUtils.ts` | None |
| `motionSmoothing.ts` | `E/videoPlayback/motionSmoothing.ts` | None (Recordly's own analytic spring) |
| `cursorPosition.ts` | `E/videoPlayback/cursorPosition.ts` | Import path |
| `constants.ts` | `E/videoPlayback/constants.ts` | Import path |
| `focusUtils.ts` | `E/videoPlayback/focusUtils.ts` | Import path |
| `cursorMotionPresets.ts` | `E/cursorMotionPresets.ts` | None |
| `squircle.ts` | `src/lib/geometry/squircle.ts` | Removed the Pixi `drawSquircleOnGraphics`; ctx type widened to OffscreenCanvas |
| `zoomSuggestionUtils.ts` | `E/timeline/zoomSuggestionUtils.ts` | Import path |
| `zoomRegionUtils.ts` | `E/videoPlayback/zoomRegionUtils.ts` | Import path |
| `cursorFollowCamera.ts` | `E/videoPlayback/cursorFollowCamera.ts` | Import path; `interpolateCursorPosition` taken from `cursorPosition` instead of the Pixi `cursorRenderer` |
| `sceneMotion.ts` | `E/videoPlayback/sceneMotion.ts` | Import path |
| `zoomTransformMath.ts` | `E/videoPlayback/zoomTransform.ts` | Only the pure geometry (`computeZoomTransform` and helpers); Pixi camera code not copied |
| `directionalMotionBlur.ts` | `E/videoPlayback/zoomTransform.ts` | Only the pure `computeDirectionalMotionBlur` (used by `frameMotionSample`); the Pixi filter isn't copied |
| `sceneEffects.ts` | `E/videoPlayback/sceneEffects.ts` | None |
| `shadowProfile.ts` | `src/lib/exporter/shadowProfile.ts` | None |
| `layoutMath.ts` | `E/videoPlayback/layoutUtils.ts` | Only the pure helpers (`computePaddedLayout`, `scalePreviewBorderRadius`, constants); Pixi removed |
| `wallpaperFill.ts` | `src/lib/exporter/frameRenderer.ts` (`setupBackground` ≈L555–667, `configureHighQuality2DContext` ≈L207) | Pulled out as standalone functions |
| `webcamOverlay.ts` | `E/webcamOverlay.ts` | None |
| `cursorCanvas.ts` | `E/videoPlayback/cursorRenderer.ts` | Pixi removed: `PixiCursorOverlay` became `CanvasCursorOverlay`, `Assets.load` replaced by fetch → `createImageBitmap`, Pixi motion blur dropped |
| `cursorScale.ts`, `cursorViewport.ts`, `cursorSway.ts`, `frameMotionSample.ts` | `E/videoPlayback/` (same names) | Import paths; `frameMotionSample` uses `directionalMotionBlur` |
| `uploadedCursorAssets.ts` | `E/videoPlayback/uploadedCursorAssets.ts` | Vite SVG imports became runtime URLs (`cursors/<set>/<file>.svg`) |
| `LICENSE.md` | `LICENSE.md` | Verbatim (AGPL-3.0 + Recordly's attribution/branding terms + the OpenScreen MIT notice) |

### Assets (`static/`)

| Glide path | Recordly source @ `e4a9d04` |
| --- | --- |
| `static/wallpapers/tahoe-light.jpg` (default), `tahoe-dark.jpg`, `sequoia-blue-orange.jpg`, `ventura.jpg`, `glassmorphism-4.jpg` | `public/wallpapers/` (the same 5 files) |
| `static/cursors/tahoe/**`, `static/cursors/golden-gate/**` | `src/assets/cursors/tahoe/`, `src/assets/cursors/golden-gate/` (all files) |
| `static/cursors/macos/*`, `static/cursors/windows11/*` | `src/assets/cursors/macos/`, `src/assets/cursors/windows11/` (the 9 files each that `uploadedCursorAssets.ts` references) |
| `static/cursors/custom/minimal-cursor.svg` | `src/assets/cursors/custom/minimal-cursor.svg` |

### Tests (`test/unit/`)

| Glide test | Recordly source @ `e4a9d04` (import paths changed only) |
| --- | --- |
| `zoomSuggestionUtils.test.ts` | `E/timeline/zoomSuggestionUtils.test.ts` |
| `zoomAnimation.test.ts` | `E/videoPlayback/zoomAnimation.test.ts` |
| `zoomCursorFollowCamera.test.ts` | `E/videoPlayback/cursorFollowCamera.test.ts` |
| `zoomSceneMotion.test.ts` | `E/videoPlayback/sceneMotion.test.ts` |
| `layoutUtils.test.ts` | `E/videoPlayback/layoutUtils.test.ts` (pure cases only) |
| `sceneEffects.test.ts` | `E/videoPlayback/sceneEffects.test.ts` |
| `webcamOverlay.test.ts` | `E/webcamOverlay.test.ts` |
| `webcamShadowProfile.test.ts` | `src/lib/exporter/shadowProfile.test.ts` |
| `cursorScale.test.ts`, `cursorSway.test.ts`, `cursorViewport.test.ts`, `frameMotionSample.test.ts`, `uploadedCursorAssets.test.ts` | `E/videoPlayback/` (same names; Vite-only asset assertions dropped) |

Written for Glide: `zoomGlide`, `frameGlide`, `webcamGlide`, `cursorGlide`, `settingsGlide`.

### Mirrored rather than copied

These follow Recordly but are Glide code:

- `src/editor/camera.ts`:
  - `SceneCamera.step` follows `frameRenderer.updateAnimationState` (≈L1596–1677).
  - `suggestZoomRegions` follows `hooks/useZoomRegionCommands` and `hooks/useFreshRecordingAutoZoom`.
- `src/editor/render.ts`: follows `frameRenderer.compositeWithShadows` and the Pixi `cameraContainer` / mask layout.
- `src/editor/webcam.ts`: follows the webcam draw in `frameRenderer` (≈L1860–1945).
- `src/editor/settings.ts`: follows `projectPersistence.normalizeProjectEditor` and `SettingsPanel.applyCursorMotionPreset`.
- `static/editor.html` and `src/editor/main.ts`:
  - Layout from `E/layout/EditorShell.tsx` and `EditorSidebar.tsx`.
  - Controls, labels and ranges from `E/SettingsPanel.tsx` and `src/i18n/locales/en/settings.json`.
  - Gradient and colour presets copied as data from `SettingsPanel.tsx`.

Written for Glide: extension wiring, recorder, content script and coordinate mapping, `telemetry.ts`, `compose.ts`, `export.ts`, the editor DOM/CSS, and all e2e tests.

## Design decisions and what we learned

**Stack: TypeScript + plain DOM + esbuild + Canvas 2D.** Recordly is Electron + React + Pixi.js (WebGL).
- The logic that defines the feel, which is zoom suggestions, region timing, springs, follow camera, layout and webcam geometry, is pure TypeScript with no Pixi or React dependency. We could copy it verbatim and run Recordly's own unit tests against it.
- Recordly's export renderer (`frameRenderer.ts`) already composites its final frame with Canvas 2D, including `ctx.filter` drop-shadows. Canvas 2D therefore reproduces the look without bringing in Pixi.
- The editor is one page with about 40 controls, so plain DOM with no framework keeps the bundle small, keeps MV3's CSP simple (no eval, no remote code) and builds in milliseconds with esbuild.
- The cost: everything that is a Pixi/WebGL filter in Recordly (zoom motion blur, cursor motion blur) is not ported.

**Recordly's zoom model differs from what Glide had.** Glide used to crop inside the frame. Recordly scales and translates the whole video layer (frame, video and cursor) over a static background, with focus relative to the video mask. We switched to Recordly's model. That is why a zoomed frame shows the wallpaper at the edges.

**Export runs in the editor tab, not the service worker.**
- MV3 service workers have no DOM and Chrome stops them after about 30 s idle.
- Glide's export (Mediabunny decode → `OffscreenCanvas` → WebCodecs encode) runs entirely in the editor page and never messages the worker, so a multi-minute export can't be cut off.
- The earlier e2e error "service worker not found" was a test bug, not an export bug: the test looked for the worker minutes after it had idled out. The test now wakes it the way a user would (opening the popup).
- Recording follows Chrome's pattern: media lives in an offscreen document (`DISPLAY_MEDIA` / `USER_MEDIA`), and the worker only orchestrates.

**Webcam bubble: 40%, not 26%.** Liz guessed about 26%. Recordly ships `DEFAULT_WEBCAM_SIZE = 40`, as a percentage of the output's shorter side (432 px at 1080p). With "reacts to zoom" on, the bubble shrinks by 1/zoom (240 px at 1.8×), so during zooms it looks close to 22–26%. We kept Recordly's 40. It's one constant (`WEBCAM_SIZE_PERCENT` in `src/editor/webcam.ts`) and a slider.

**Squircle webcam, not a circle.** At roundness 100 Recordly clips the bubble with its superellipse (`squircle.ts`, exponent 4.5), not a true circle, so it reads as a soft rounded square. We kept that for fidelity. A true circle would be a one-line change in `drawWebcamBubble` if Liz prefers it.

**One deliberate deviation: corner radius 8% on every OS.** Recordly defaults to 8% only on macOS and 0 elsewhere. Glide is used on Linux, so it uses 8%.

**Other learnings:**
- Chrome 137+ ignores `--load-extension`; the tests load the extension with Puppeteer's `installExtension` over CDP.
- Chrome on Linux has no AAC encoder in WebCodecs, so MP4 audio is Opus.
- Recordly's auto-zoom only uses explicit clicks. Dwell and hover don't trigger zooms.
- Parallel porting worked because P0 vendored the shared files first and every package owned disjoint files. The only merge conflicts were the vendor README table and one byte-identical file.

## Defaults

All values are Recordly's (`projectPersistence.ts`, `types.ts`, `cursorMotionPresets.ts`), except the radius noted above.

| Area | Setting | Default |
| --- | --- | --- |
| Motion | Preset | **Focused** (zoom in/out 200 ms, zoom smoothness 0.5) |
| Zoom | Auto-apply on fresh recording | On; explicit clicks only; landscape sources only (aspect ≥ 1.2) |
| | Click clustering | Clicks ≤ 2500 ms apart merge; 500 ms pad before and after; focus = strongest click |
| | Depth | 3 = **1.8×** (scale list 1.25 / 1.5 / 1.8 / 2.2 / 3.5 / 5) |
| | Easing | `cubic-bezier(0.16, 1, 0.3, 1)` on region strength; connected pans 1000 ms when gap ≤ 1350 ms |
| | Camera spring | stiffness ×1, damping ×1.13, mass ×1.12 |
| | Connect Zooms | On |
| | Follow | Recenter when the cursor leaves the 25% safe zone; frozen while zooming out |
| Background | Wallpaper | `tahoe-light.jpg`, blur 0 |
| Frame | Padding | 20 (= 4% of the canvas per side) |
| | Radius | **8%** of the short side, squircle (Recordly: 8% macOS / 0 elsewhere) |
| | Shadow | 0.67 (drop-shadows 12/48/.7, 4/16/.5, 2/8/.3 × intensity × width/640) |
| Cursor | Style / size | Tahoe (hands from Golden Gate) / 2.5 |
| | Smoothing / spring | 0.67 / stiffness ×1.35, damping ×0.79, mass ×1.29 |
| | Click bounce / sway / effect | 2 over 350 ms / 0.4 / off |
| | Shown | Tab recordings only, until toggled (see warnings) |
| Webcam | Size / roundness / shadow | **40%** of short side / 100 (squircle) / 0.3 |
| | Position / margin | Bottom-right / 24 px at 1920 wide |
| | Mirror / reacts to zoom | On / on (shrinks by 1/zoom) |
| Output | Aspect / size / fps | 16:9 / 1920×1080 / 30 |

## Gaps, todos and warnings

### Not ported
- **Zoom motion blur** and **cursor motion blur**: Pixi/WebGL filters in Recordly.
- **Device frames**, **captions**, **annotations**.
- General **Crop** controls and unlinked (per-side) padding. Browser-top crop is described above.
- Interior **cut** and speed edits. Start/end trim is described above.
- Advanced zoom-curve controls (durations, curves, overlap): only reachable through the Focused/Smooth presets.

### Todos
- Interior cuts and general crop on the timeline; retained-range trim and browser-top crop are implemented above.
- Port motion blur (a WebGL pass, or a Canvas 2D approximation).
- Faster export: cache the shadowed frame layer when the camera is still, and add a 60 fps option.
- Optional true-circle webcam toggle.

### Warnings
- **Export is slow on CPU.** About **3.5 min per 12 s of 1080p** per container on the CI box (MP4 214 s, WebM 218 s). The three stacked blurred drop-shadows are the expensive part without a GPU. Expect much faster on a desktop with hardware encode.
- **New recording pointer telemetry is disabled until source identity is verified.** The content-script path remains, but the recorder rejects all unknown-source events. Therefore new captures have no automatic click zooms or post-rendered cursor effects. Manual zooms and imported/saved telemetry still work.
- **Native cursor behaviour varies by browser.** Window/screen captures may bake in the OS cursor; showing a drawn cursor cannot remove a baked-in one or create missing telemetry.
- **Artwork license risk. The repo is public.**
  - 19 of the 38 upstream wallpapers are bundled (trimmed by half on 2026-10-18). Some resemble Apple artwork; others have unknown provenance. Cursor sets (`tahoe`, `golden-gate`, `macos`, `windows11`) also carry Apple/Microsoft-derived-artwork risk. Recordly supplies no separate artwork licence; AGPL code licensing does not establish image rights.
  - Publishing them in a public repo is a copyright risk. Replace them with CC0 or self-made assets, or make the repo private.
  - Code licensing is fine: AGPL-3.0, with Recordly credited in the UI and repo, and Glide not branded as Recordly.
- **Linux MP4 audio is Opus.** Chrome on Linux has no AAC encoder in WebCodecs. Most players handle Opus in MP4, but some editors (for example CapCut) don't. Fix without re-encoding the video:

  ```bash
  ffmpeg -i glide.mp4 -c:v copy -c:a aac glide-aac.mp4
  ```
- Some Chromium builds have no H.264 encoder. Glide then writes VP9 in MP4 and says so in the status line.
