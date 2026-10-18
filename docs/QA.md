# Glide QA / UX / PM pass on `3f5638b`

Run on 2026-10-18 (Asia/Shanghai, UTC+8). Tree: `origin/main` = `3f5638b`, pulled fast-forward. No product code was changed. Screenshots and the walkthrough harness (`walk.mjs`, `walk2.mjs`) live in [`docs/qa/`](qa/); logs stayed on the test box.

**Status:** original findings below are preserved as tested on `3f5638b`; see the R2 reconciliation here before treating them as current.

### R2 reconciliation (2026-10-18)

- Implemented: P1-2 (known tab sources cannot crop browser top), P1-5 default back to Single tab, P1-6 raw stream IDs removed, P1-7 disabled no-media actions/recovery copy, P1-8 cancellation copy and duplicate export/import lock, P1-9 shortcut hints/Z/global arrows, P1-10 self-hosted Geist, P1-11 two sections, P1-12 fewer visible controls, P1-13 all 38 static wallpapers, P2-1 dynamic surface note, P2-2 human surface/date labels, P2-4 filled-button contrast, P2-8 portable Chrome lookup in the persistence test.
- P1-1 is removed from the visible picker rather than fixed: old saved gradient backgrounds still use the existing parser.
- P1-3 is contained, **not fully restored**: recorder rejects all unknown-source pointer events. This prevents contamination but disables click auto-zooms and drawn-cursor effects on every new capture. Verified source identity still needs a separately approved implementation; no extra permissions were added. Manual zooms and saved/imported telemetry remain supported.
- P2-9: removed page-mode self-capture auto-accept; test decodes real frames and asserts target colour in headful mode. Headless selection remains explicitly unverified, not target-tab acceptance.
- Integration: 195 unit tests / 23 files, typecheck/build, and real-browser project persistence pass. This includes old tab-crop guard, window crop/reload, reduced UI, import boundaries and missing-ID recovery. Worker font checks loaded actual packaged fonts; all 38 image bytes match the pinned Recordly checkout.
- Still open: native target-tab/window acceptance, restoration of source-verified pointer effects, countdown, undo, draggable trim, export ETA/resolution/performance, keyboard file-picker access, full empty-card visual redesign, video wallpaper and artwork rights. Parent browser acceptance verified immediate duplicate export/import lock, cancellation copy, and action recovery without a long encode. Page-mode recording/status/save/editor also passes with zero retained events; decoded headless frames did not prove the target tab and are explicitly unverified. The original screenshot harness below still references removed controls and must be adapted before reuse.

## Verdict
**Minimally usable: yes.** Every core step works end to end:
- record (single tab)
- auto zooms
- edit
- reopen with edits kept
- trim
- export MP4 and WebM

**No P0.** The worst problems are:
- 7 of the 12 gradient backgrounds render **black**.
- "Hide browser top" crops real page content on tab recordings.
- Pointer data is taken from every tab.
- Starting a recording takes 3 steps, with no countdown.

## 1. QA results
| Check | Result |
|---|---|
| `tsc` | ✅ exit 0 |
| `vitest` | ✅ 22 files, 188 tests |
| `npm run build` | ✅ |
| `npm test` (full e2e) | ✅ EXIT 0 (`e2e.log`) |
| `npm run test:record` (monitor) | ✅ RECORD SMOKE OK (`record.log`) |
| `record-smoke` `PAGE_MODE=1 SURFACE=browser` | ✅ OK (`record-page.log`), but see P2-9: it records the wrong tab |
| `npm run test:project` (default) | ❌ `Browser was not found at /usr/bin/chromium` (`project-default.log`). Environment or default-path problem, not a logic failure |
| `CHROME=/usr/bin/google-chrome npm run test:project` | ✅ EDITOR PERSISTENCE OK (`project.log`) |

**Walkthrough** (`walk.mjs`, run headful under xvfb with the real popup, recorder tab and editor; plus `walk2.mjs` on the fixture editor):

**Works:**
- Popup → recorder tab → Start → Stop from the popup → editor opens. The recorder tab closes itself.
- Rail panels (08-panel-*).
- +Zoom at the playhead (09-zoom-added).
- Drag and resize. Resize clamps against the next zoom, so no overlap (09b).
- Manual focus by clicking the preview (10).
- The Delete key.
- ←/→ seek and Space play.
- Aspect 9:16 (11), wallpaper switch (12), webcam toggle (14), trim (16).

**Reopen keeps edits ✅** (17). After a reload the zooms, trim and browser view are identical, so Liz's "keeps recordings editable" claim holds.

**Exports** (ffprobe):

| Format | Video / audio | Size | Duration | Frames | Wall time |
|---|---|---|---|---|---|
| MP4 | H.264 / Opus | 1920×1080 | 7.58 s, matches the 7.56 s trim | 227 | 108 s |
| WebM | VP9 / Opus | 1920×1080 | 7.58 s | 227 | 104 s |

Wall times are on this CPU-only box, about 14× realtime. Frames: `21-export-frame-{mp4,webm}.png`.

**Not verifiable here:** the first-run mic/camera prompt. `--use-fake-ui-for-media-stream` auto-grants the permission, so the redirect to `setup.html` never fired.

## 2. Findings

### P1: should fix

**P1-1 · 7 of the 12 gradient presets render black, in both preview and export** · ⚡ quick win (~20 min)
- **Repro:** Scene → Background → Gradient → pick preset 1, 3, 4, 5, 6, 7 or 8. The swatch shows a gradient but the canvas is black.
- **Console:** `[FrameRenderer] Error setting up background … addColorStop … ('rgba') / ('circle') could not be parsed as a color`.
- **Edge pixels sampled** (`walk2-findings.json`): `0,0,0` for presets 1, 3, 4, 5, 6, 7, 8.
- **Evidence:** [`13-gradient.png`](qa/13-gradient.png), [`13b-gradient1-black.png`](qa/13b-gradient1-black.png).
- **Root cause:** `src/vendor/recordly/wallpaperFill.ts` (`paintWallpaper`, about lines 75–110) runs `params.split(",")`. That splits *inside* `rgba(…)`. In radial gradients it also treats `circle farthest-corner at …` as a colour. Angles and stop % values are ignored too, so even the hex presets come out vertical and evenly spaced, which doesn't match the swatch. The same bug exists upstream in Recordly (`frameRenderer.ts:616`).
- **Fix:**
  - Split only on top-level commas: `params.split(/,(?![^()]*\))/)`.
  - Skip the first token when it is an angle, `to …` or a radial shape.
  - Read the `NN%` stop positions.
  - Map `deg` to `createLinearGradient` endpoints.
  - Add a unit test that runs all 12 `GRADIENTS` (`src/editor/main.ts:41`) through it.

**P1-2 · "Hide browser top" crops real content on single-tab recordings** · ⚡ quick win (~15 min)
- **Repro:** record in "Single tab" mode → editor → Scene → tick *Hide browser top in export*. 100 px of the page is cut off: the "Glide recorder" heading disappears in both preview and export.
- **The contradiction:** the hint right under the checkbox says *"This single-tab recording has no real browser top to restore."*
- **Evidence:** [`15-browser-top-hidden-tab-recording.png`](qa/15-browser-top-hidden-tab-recording.png), [`21-export-frame-mp4.png`](qa/21-export-frame-mp4.png) (heading cut off).
- **Fix:** in `src/editor/main.ts`, where the browser-top controls are synced, disable `#browser-hide-top` and `#browser-top-px` when `meta.surface === "browser"`, not only when there's no `screenBlob`. In `browserView.ts`, make `browserCrop` return the full frame for tab recordings, even if an old project saved `hideTop: true`.

**P1-3 · Pointer events come from every tab, not just the captured one** · ~1–2 h
- **Repro:** start a single-tab recording of tab A, then click in tab B or in another window. Those clicks become auto-zooms and drawn-cursor positions on tab A's video.
- **Evidence:** the harness saw this by accident. Chrome's auto-accept flag captured the recorder tab while the clicks happened on GlideTarget. The editor built zooms and a cursor from those clicks and drew them over unrelated content ([`07-editor-fresh-recording.png`](qa/07-editor-fresh-recording.png), [`21-export-frame-mp4.png`](qa/21-export-frame-mp4.png)).
- **Root cause:**
  - `background.ts` `startPointerLogging()` injects `content.js` into all tabs.
  - `content.ts` `send()` posts with no tab identity.
  - `recorder.ts:177` pushes every event.
- **Fix:**
  - Add `sender.tab.id` and `windowId` to each event where it is received.
  - Tab mode: identify the captured tab. Option one is Capture Handle: the content script calls `navigator.mediaDevices.setCaptureHandleConfig({ handle: <tabToken>, permittedOrigins: [extension origin] })`, and the recorder reads `vTrack.getCaptureHandle()`. Option two is to pick the tab with `chrome.desktopCapture` / `tabCapture`, which hands back the tab id.
  - Window mode: keep only events from the captured window's tabs.
  - Minimum fallback: drop events when `document.visibilityState !== "visible"` or `!document.hasFocus()`.

**P1-4 · Starting a recording takes 3 steps, with no countdown** · not quick (half a day)
- **Flow today:** popup *Record* → popup closes and a recorder tab opens → click *Start recording* ([`05-recorder-page.png`](qa/05-recorder-page.png)) → Chrome picker → recording starts at once.
- **Comparison:** Screen Studio and Recordly go one click to the source picker, then a 3-2-1 countdown (Recordly `src/components/countdown/CountdownOverlay.tsx`).
- **Why it hurts:** the extra page is a bare dark screen. It is also the tab that has focus when recording starts, so the first seconds of every recording are the recorder tab.
- **Fix:**
  - Open the picker straight from the popup click with `chrome.desktopCapture.chooseDesktopMedia(["tab","window","screen"], recorderTab)`, then start the stream from the streamId on the recorder page. One click total.
  - Or keep the recorder page but auto-trigger Start from the popup's user gesture.
  - Add a 3 s countdown overlay or badge, and trim the first second automatically.

**P1-5 · The default (Window) recording has no smooth cursor or click effects (Screen Studio's signature)** · ⚡ quick-ish (~30 min for the default and the copy)
- **What happens:**
  - Liz made **Window** the default surface (`popup.html` and `recorder.ts`).
  - Chrome ignores `cursor: "never"` (`recorder.ts:46`), so the OS cursor is baked into the video.
  - The editor therefore turns the drawn cursor off for anything but tab mode (`main.ts:762`).
  - Result: by default users get no smoothed cursor, no click ripple and no cursor scale, and they get the tab strip in the export unless they find the Scene toggle.
- **Decision (Liz, 2026-10-18):** default back to **Single tab**. Not yet implemented.
- **Fix options considered:**
  - Either keep Window but default `hideTop: true` for window recordings and say in the popup that the cursor is baked in.
  - Or default to Single tab for the "polished demo" path.
  - Either way, add a notice in the Cursor panel explaining why the cursor is off.

**P1-6 · Raw stream id shown to users, and burned into recordings** · ⚡ quick win (5 min)
- **Repro:** start any page-mode recording. Status reads `Recording web-contents-media-stream://9:17. This captures one tab only…` (screen mode shows `screen:-3:0`).
- **Evidence:** `15-…png`, [`21-export-frame-mp4.png`](qa/21-export-frame-mp4.png), `record-page.log`.
- **Fix:** `src/recorder.ts:234-237`: drop `${res.name}`, or map the surface to "this tab" / "this window" / "your screen".

**P1-7 · Empty and error states are hard to read and leave actions live** · ⚡ quick win (~30 min)
- **Repro:** open `editor.html` with no id, or with `?id=does-not-exist`.
  - The "No recording loaded…" text is small grey type over the bright default wallpaper and is unreadable ([`22-editor-empty.png`](qa/22-editor-empty.png)).
  - A bad id shows only `Error: Recording does-not-exist not found` in tiny header text over a wallpaper, with no next step ([`23-editor-bad-id.png`](qa/23-editor-bad-id.png)).
  - Export MP4/WebM stay enabled and clicking them just sets the status to "Open files to start". In the bad-id state, Set start and Set end are enabled too.
- **Fix:**
  - `static/ui.css` / `editor.html` `.empty`: a solid panel card at `--panel` with a 16 px font, a primary "Record" button and a "Recent recordings" list. The list could reuse `popup.ts` `renderRecent`.
  - `main.ts`: one `setHasMedia(bool)` that disables `#export-*`, the trim buttons and +Zoom until `state.screenBlob` exists.
  - For a bad id, show "This recording was deleted or isn't on this device" plus a link to Recent.

**P1-8 · Export: cancelling reads as a failure, there's no ETA, and controls stay live** · ⚡ quick win (~25 min)
- **Repro:** Export MP4 → Cancel. The status says **"Export failed: Export cancelled"** ([`20-export-cancelled.png`](qa/20-export-cancelled.png)).
- **During export** ([`19-export-progress.png`](qa/19-export-progress.png), [`19b-double-export.png`](qa/19b-double-export.png)):
  - Both export buttons and Open files stay enabled.
  - Clicking WebM mid-export is silently ignored.
  - Every editor control stays editable.
  - There's no time estimate; on CPU a 7.6 s clip takes about 108 s.
- **Fix:** in `src/editor/main.ts`, in the export handler (about lines 686–714):
  - Catch `e.name === "AbortError"` and show "Export cancelled".
  - While `ctrl` is set, disable `#export-mp4`, `#export-webm` and `#open-files`, and label the active button "Exporting… 34%".
  - Show an ETA from elapsed time and progress.
  - Snapshot settings at export start, or add a `pointer-events:none` overlay on the rail and timeline, so mid-export edits can't produce mixed frames.
  - Optional: `beforeunload` guard while exporting.

**P1-9 · Keyboard: discoverability went backwards, and there's no undo** · hint, `Z` and Space ⚡ (~20 min); undo is not quick (~2 h)
- **What changed:** `3f5638b` replaced the only shortcut hint (`Space play/pause · ←/→ seek · Delete removes the selected zoom`) with the trim buttons. Nothing in the UI mentions shortcuts now.
- **Gaps:**
  - No `Z` to add a zoom (Recordly `src/lib/shortcuts.ts`: `addZoom: z`).
  - No Ctrl/⌘+Z undo (Recordly `hooks/useEditorHistory.ts`). A mis-drag or Delete can't be reversed, and since edits now autosave to localStorage the mistake is permanent.
  - Space after clicking any button re-activates that button instead of play/pause (`walk2`: after clicking +Zoom, Space didn't play).
  - ←/→ only seek when the timeline has focus.
- **Fix:**
  - Put the hint back as a `?` popover or a compact line in the timeline header.
  - In the `bindTransport` `keydown` handler (`main.ts:~660`): map `z`/`Z` to `addZoomAtPlayhead`, handle `ArrowLeft`/`ArrowRight` globally, and on `Space` call `preventDefault` and toggle even when focus is on a non-input `<button>` (blur it first).
  - Add an undo stack around `regionsChanged()`/`changeTrim()`/`saveProject()`: keep the last 50 snapshots of `{regions, trim, browserView}`.

### P2: polish

**P2-1 · Popup surface note never updates** · ⚡ (10 min)
- **Repro:** choose Single tab or Entire screen. The note still says *"Window records the browser chrome too…"* ([`06-popup-recording.png`](qa/06-popup-recording.png), [`18-popup-recent.png`](qa/18-popup-recent.png)).
- **Cause:** the text is static in `static/popup.html:11`.
- **Fix:** in `src/popup.ts`, set `#surface-note` from a `{window, browser, monitor}` copy map on load and on `#surface` `change`.

**P2-2 · Recent list copy** · ⚡ (10 min)
- **What's wrong:** entries look like `10/18/2026, 9:52:56 AM · 9s · browser`. They use the internal enum ("browser" means tab), a US date format, and there's no thumbnail, delete or rename ([`18-popup-recent.png`](qa/18-popup-recent.png)).
- **Fix:** `popup.ts:30`:
  - Labels `{browser:"Tab", window:"Window", monitor:"Screen"}`.
  - `toLocaleString(undefined, {dateStyle:"medium", timeStyle:"short"})`.
  - Relative time ("2 min ago").
  - Later: a delete icon that calls `db.ts` delete and clears the `glide.project.v1.<id>` key.

**P2-3 · Trim is button-only** · ~1–2 h
- **What's missing:** no draggable in/out handles on the timeline. Trimmed areas are dimmed only on the "Recording" lane, not on the zoom lane ([`16-trim.png`](qa/16-trim.png)). Screen Studio and Recordly both trim by dragging clip edges.
- **Fix:** add start and end handles to the `drawTimeline()` recording track using the same pointer logic as zoom resize, and dim the zoom lane outside the trim too.

**P2-4 · Primary and danger button contrast is below WCAG AA** · ⚡ (5 min)
- **Measured:**
  - White on `--accent #4f8cff` = **3.22:1**.
  - White on `--danger #e5484d` = 3.91:1.
  - AA needs 4.5:1 at 14 px.
  - Muted text is fine: `#8a91a3` on `#12151c` = 5.79:1.
- **Fix:** `static/ui.css` `:root`:
  - Use `--accent:#2f6fe0` (4.7:1) for button backgrounds; keep `#4f8cff` for links and focus rings.
  - Use `--danger:#c93338` (5.23:1).

**P2-5 · "Open files" can't be reached by keyboard** · ⚡ (10 min)
- **Cause:** `editor.html:16` is a `<label class="btn">` wrapping a `hidden` file input, so it isn't focusable.
- **Fix:** make it a `<button>` that calls `$("open-files").click()`.

**P2-6 · +Zoom feedback**
- **What's wrong:** when the playhead is inside an existing zoom, +Zoom silently selects that zoom. With no room left it shows "No room for a zoom here", and that header status sticks until something overwrites it (`15-…png`).
- **Fix:** use a toast that disappears after about 3 s, and say "Selected existing zoom" when that's what happened.

**P2-7 · Export speed and resolution**
- **What's wrong:** an 1100×600 tab is always exported at 1920×1080, about 14× realtime on this CPU box. There's no resolution or quality choice (Recordly and Screen Studio offer 720p/1080p/4K plus a quality setting).
- **Fix:** add an export-settings popover (resolution, fps, quality) next to the export buttons, and default to source-size × devicePixelRatio when the source is small.

**P2-8 · `test:project` hard-codes `/usr/bin/chromium`** · ⚡ (5 min)
- **Cause:** `test/editor-persistence.mjs` defaults `CHROME` to that path.
- **Fix:** use the same resolution as `e2e.mjs` / `record-smoke.mjs` (`/usr/bin/google-chrome` or an env fallback chain).

**P2-9 · The page-mode smoke test doesn't prove the target tab is captured** · ⚡ (20 min)
- **Cause:** `--auto-accept-this-tab-capture` makes Chrome capture the recorder tab itself, so `PAGE_MODE=1` passes while recording the wrong tab ([`21-export-frame-mp4.png`](qa/21-export-frame-mp4.png) shows the recorder, not GlideTarget).
- **Fix:** in `test/record-smoke.mjs`, drop that flag for page mode (keep `--auto-select-tab-capture-source-by-title`), then assert a frame of the recording contains the target page colour.

**P2-10 · Visual polish**
- Header status text is tiny and low-priority grey.
- The Browser-top section now sits *above* Background in the Scene panel, so the most-used control (wallpaper) moved down. Consider putting "Browser top" under Frame.
- The webcam bubble defaults to a large size that covers about 20% of a 16:9 frame (`07-…png`). Recordly's default is smaller; consider about 15% of width.

### Liz's review (2026-10-18), added after the pass

**P1-10 · The UI font looks bad** · ⚡ (~20 min)
- **What's wrong:** the editor and popup use the system default stack, which looks generic and uneven across OSes.
- **Decision (Liz):** use **Geist Sans** for UI text and **Geist Mono** for numbers, timecodes and values (both OFL-1.1, by Vercel).
- **Fix:** vendor the woff2 files under `static/fonts/` (the extension must work offline, so no CDN), declare `@font-face` in `static/ui.css`, set `--font-sans` / `--font-mono` on `:root`, and apply mono to slider values, the timecode and the timeline ruler. Add the OFL notice to `THIRD_PARTY_NOTICES.md`.

**P1-11 · Four rail sections is too much; keep two at most** · ~1 h
- **What's wrong:** Scene / Cursor / Webcam / Settings splits a handful of controls across four tabs. For a small tool that's more navigation than content.
- **Decision (Liz):** two sections at most.
- **Suggested split:** **Look** (background, frame, webcam on/off and corner) and **Motion** (zoom preset Focused/Smooth, cursor on/off, click effect). Everything else moves into the defaults. The zoom-block panel stays contextual, opening only when a zoom is selected. Or drop the rail entirely and use one scrolling panel with two headings.

**P1-12 · Cut the options per parameter to the minimum** · ~1–2 h
- **What's wrong:** most controls expose Recordly's full range, e.g. 4 click effects, 12 colours, 12 gradients, free sliders for shadow, radius, padding, blur and cursor size, and zoom levels 1.25×–5×.
- **Decision (Liz):** tune the defaults so most users touch nothing, and keep as few choices as possible.
- **Suggested direction:**
  - Replace continuous sliders with 2–3 presets where possible, e.g. padding S/M/L, shadow on/off.
  - Drop background blur, radius and cursor size from the UI and keep the tuned defaults.
  - Click effect becomes on/off (ripple).
  - Zoom level becomes 3 steps (1.5× / 1.8× / 2.5×).
  - Webcam becomes on/off plus corner.
  - Keep "Reset to defaults".

**P1-13 · Backgrounds: drop our own gradients and colours, ship all of Recordly's wallpapers** · ⚡ (~30 min)
- **What's wrong:** the picker shows 5 Recordly images plus 12 gradients (7 render black, see P1-1) plus 12 flat colours. The gradients and flat colours look cheap. Recordly bundles 39 wallpapers, all of which look good ([`24-recordly-wallpapers.png`](qa/24-recordly-wallpapers.png) is a contact sheet of the images).
- **Decision (Liz):** don't add backgrounds of our own. Take **every** wallpaper Recordly ships, as-is. Both projects are open source.
- **Update (Liz, 2026-10-18 afternoon):** 39 is too many. Keep half: `tahoe-light` (default) and every `wallpaper*` file, plus 7 picked at random from the rest. Done in code; the 19 removed files are listed in `THIRD_PARTY_NOTICES.md`.
- **Original fix:**
  - Remove the Color and Gradient tabs and the `GRADIENTS` / `COLORS` presets in `src/editor/main.ts`. This also makes P1-1 moot.
  - Copy all files below from Recordly `public/wallpapers/` @ e4a9d04 into `static/wallpapers/`, in Recordly's order. Keep `tahoe-light.jpg` as the default (Recordly's `DEFAULT_WALLPAPER_PATH`).
  - `wispysky.mp4` is a video wallpaper. Include it if the renderer can draw a looping video background; otherwise list it as a follow-up.
  - Keep "Upload custom".
  - Update `THIRD_PARTY_NOTICES.md` with the full list. The Apple-artwork caveat still applies.
- **Full list (39 files):**
  - `bluerays.jpeg`
  - `cherrypop.jpg`
  - `cityscape.jpg`
  - `energy-17.jpg`
  - `energy-19.jpg`
  - `farmvalley.jpg`
  - `glassmorphism-3.jpg`
  - `glassmorphism-4.jpg`
  - `ipad-17-dark.jpg`
  - `ipad-17-light.jpg`
  - `iridescent-9.jpg`
  - `lemonade.jpeg`
  - `levels.jpg`
  - `luisdelrio.jpg`
  - `midnight-8.jpg`
  - `mountaintrees.jpg`
  - `sequoia-blue-orange.jpg`
  - `sequoia-blue.jpg`
  - `sonoma-clouds.jpg`
  - `sonoma-dark.jpg`
  - `sonoma-evening.jpg`
  - `sonoma-horizon.jpg`
  - `sonoma-light.jpg`
  - `tahoe-dark.jpg`
  - `tahoe-light.jpg`
  - `ventura-dark.jpg`
  - `ventura.jpg`
  - `wallpaper1.jpg`
  - `wallpaper10.jpg`
  - `wallpaper11.jpg`
  - `wallpaper12.jpg`
  - `wallpaper13.jpg`
  - `wallpaper15.jpg`
  - `wallpaper2.jpg`
  - `wallpaper3.jpg`
  - `wallpaper4.jpg`
  - `wallpaper7.jpg`
  - `wallpaper9.jpg`
  - `wispysky.mp4`

## 3. Quick wins (each ≤ ~30 min)
P1-1 (gradient parser), P1-2 (disable browser-top for tab recordings), P1-6 (raw stream id), P1-7 (empty/error states and disabled actions), P1-8 (cancel copy and locking during export), the quick half of P1-9 (shortcut hint, `Z`, Space), P1-5 (default and copy, once Liz decides), P2-1, P2-2, P2-4, P2-5, P2-8, P2-9, P1-10 (fonts), P1-13 (backgrounds).

## Artifacts
- **Screenshots:** `docs/qa/*.png` (01, 04–23, 09b, 10, 13b, 19b). The real-recording walk is 01–23; the fixture-editor walk is 09/09b/10/13b/19b.
- **Logs (on the test box only, not committed):** `e2e.log`, `record.log`, `record-page.log`, `project-default.log`, `project.log`, `walk.log`.
- **Raw data (test box only):** `walk-findings.json`, `walk2-findings.json`.
- **Harness:** `docs/qa/walk.mjs`, `docs/qa/walk2.mjs` (written for the test box; paths may need adjusting).
