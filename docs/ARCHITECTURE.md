# Architecture

Every claim marked **verified** below was measured on this machine, not assumed.
The experiments are reproducible from the notes in `docs/STATUS.md`.

---

## 1. What this server does

It records narrated walkthrough videos of web apps. An agent drives a browser that
is already signed in to the app, speaks over what it is doing, and gets back a
finished mp4 with voice-over and background music.

The target is the informative screen recording — "here is how you verify your
account in this app" — not audience-optimised content.

---

## 2. Capture: how pictures get out of the browser

Four approaches were tested. Three failed for concrete, measured reasons.

### Rejected: ffmpeg `gdigrab` window capture

`-f gdigrab -i "title=… Google Chrome"` returns **pure black**. Average luma was
`YAVG=16` on every frame — 16 is the YUV value for black — and two seconds of
"video" weighed 7 KB. Chrome composites through the GPU, so a GDI-based grabber has
nothing to read. Desktop capture of the same screen produced 1.9 MB and `YAVG=49`,
confirming the grabber itself works and the problem is Chrome specifically.

### Rejected: ffmpeg desktop region capture

Works technically, but captures *whatever occupies those screen coordinates*, not
the target window. A test grab of Chrome's exact rectangle returned an entirely
different application that happened to be in front. That means the machine cannot
be used during a recording and any notification lands in the video. The coordinate
maths is fragile too: on this six-monitor mixed-DPI setup `gdigrab` reports the
desktop as 10560x4320 while the DPI-aware Win32 API reports 7680x4320, and
`offset_x/offset_y` turned out to be absolute virtual-desktop coordinates rather
than offsets from the origin.

### Rejected: recording the existing `@playwright/mcp` browser

That server runs with `--extension`, bridging into the user's real Chrome through
the Playwright browser extension. Its Chromium is launched with
`--remote-debugging-pipe` and no debug port listens, so a second process has no way
to speak CDP to it. The "companion recorder" design — where our server only records
while the existing MCP drives — is therefore not possible, not merely inelegant.

### Chosen: our own Playwright browser + `page.screencast`

The server owns a Chromium it launched itself, against a persistent profile that
carries the logins.

```
chromium.launchPersistentContext(profileDir, {
  headless: true,
  viewport: { width, height },
  deviceScaleFactor: 2,
  args: ['--disable-backgrounding-occluded-windows',
         '--disable-renderer-backgrounding',
         '--disable-background-timer-throttling',
         '--hide-scrollbars'],
})
await page.screencast.start({ path, size, quality, onFrame })
```

`page.screencast` (Playwright 1.59+, **verified** present in 1.62.1) is preferred
over the older `recordVideo` context option because it starts and stops on command
— which gives an exact time origin — it exposes a `quality` setting, and it brings
the tutorial furniture with it:

- `showActions({ cursor: 'pointer' })` — an animated pointer that glides between
  targets, plus a caption naming each action. **Verified** visible in the output.
- `showChapter(title, { description })` — a centred title card over a blurred
  backdrop.
- `showOverlay(html)` — arbitrary HTML on top of the page.

Output is VP8 in WebM, viewport only, no browser chrome, no audio, at a fixed
25 fps (**verified**: `r_frame_rate=avg_frame_rate=25/1`).

**Headless is the default.** It is the only configuration immune to whatever else
happens on screen: nothing can occlude it, and the machine stays fully usable
during a recording. Headed mode stays available for sites that reject headless
browsers.

---

## 3. Keeping the timeline honest

This is the part that makes narration land on the right frame, and it needed two
findings.

### The screencast is event-driven

No repaint, no frame. **Verified**: a page sitting idle for 6 seconds delivered
**4 frames total**, with a 3009 ms gap between two of them, and the resulting video
came out 7.2 s long for 5.7 s of wall clock. A tutorial page is idle exactly when
narration is playing, so this is the normal case, not an edge case.

**Fix — a repaint heartbeat.** A 1x1 px element in the corner alternates between
two near-identical transparent colours on every animation frame. It is invisible to
a viewer but keeps the compositor producing frames. **Verified**: the same idle
6 seconds then delivered 357 frames at 59.3 fps with a 17 ms median gap and a 21 ms
worst case.

### The video clock starts at the first frame

With the heartbeat running, page colour was flipped at known wall-clock times and
those changes located in the finished video:

| marker | wall clock | in video | difference |
|--------|-----------|----------|------------|
| red    | 1006 ms   | 0.840 s  | −166 ms |
| green  | 2017 ms   | 1.880 s  | −137 ms |
| blue   | 3021 ms   | 2.880 s  | −141 ms |
| yellow | 4031 ms   | 3.880 s  | −151 ms |
| cyan   | 5037 ms   | 4.880 s  | −157 ms |

The offset is **constant at about 150 ms**, and equals the moment the first frame
was delivered (measured independently as 150 ms). Intervals are preserved exactly:
1000 ms of wall clock is 1000 ms of video. There is no stretching and no rate
error, only a fixed lead-in.

**Therefore:** `onFrame` records when the first frame lands, and every cue offset is
`wallClockTime − firstFrameWallTime`. That single subtraction is the whole
synchronisation mechanism.

The recorder also appends roughly a second of the final frame after `stop()`. That
is spare material at the end, not a timing error, and the composition step trims or
extends the tail to match the audio.

---

## 4. Narration: speak, then act

Narration is rendered to audio **at the moment it is requested**, its true duration
measured, and the recording then genuinely waits that long before continuing.

The alternative — estimating how long a sentence takes and placing audio against a
predicted timeline — accumulates error with every line. Rendering first means the
video contains exactly the time the voice needs, so picture and sound cannot drift.
There is only one clock.

Rendered audio is cached under a hash of text, voice, model and settings, so
re-recording a tutorial after changing one sentence only pays for that sentence.

---

## 5. Composition

Two ffmpeg passes, deliberately separate so each is independently inspectable when
something sounds wrong.

**Pass 1 — audio.** Narration clips are placed on a silent timeline at their cue
offsets with `adelay`, summed with `amix`, and normalised with `loudnorm` to
−16 LUFS. Background music is looped to length, faded at both ends, and pushed
under the voice with `sidechaincompress` keyed off the narration.

**Pass 2 — video and mux.** The WebM is transcoded to H.264, the mixed audio
attached as AAC, `-movflags +faststart` set for web playback.

All required filters are **verified** present in the local ffmpeg 6.1 build:
`adelay`, `amix`, `sidechaincompress`, `loudnorm`, `afade`, `atrim`, `apad`,
`anullsrc`, plus a native `aac` encoder. `libmp3lame` is absent, which does not
matter — mp3 *decoding* works, and AAC covers encoding.

**Note:** `libass` is absent, so the `subtitles=` burn-in filter is unavailable.
Soft subtitles are muxed as `mov_text` instead. Also, `drawtext` font paths need
careful escaping on Windows — a naive path fails to parse.

---

## 6. Known risks

| Risk | Mitigation |
|---|---|
| Capture silently produces black frames | Not applicable to this path (frames come from the compositor, not GDI), but the output is checked for `YAVG < 17` before being handed back |
| Timeline drift while the page is idle | The repaint heartbeat, plus the first-frame offset correction |
| Action captions reveal secrets — `showActions` prints typed values, so a verification code appears on screen | Typing into password fields, and any value marked sensitive, is entered without an action caption; a redaction helper blurs elements before they are shown |
| Narration cost | On-disk cache keyed by content; re-renders of unchanged lines are free |
| A site rejects headless Chrome | Headed mode is a per-recording option |
| stdout corrupts the MCP protocol | All logging goes to stderr; ffmpeg is spawned without inheriting stdout |
| `page.screencast` is a young API | `playwright-core` is pinned; the older `recordVideo` path remains a documented fallback and was **verified** working (constant 25 fps, time-accurate to one frame) |

---

## 7. Relationship to the existing Playwright MCP

They are independent. The existing `@playwright/mcp` keeps driving the user's real
Chrome for ordinary browsing work. This server has its own browser and its own
profile, because — as established in §2 — it cannot record the other one.

The one-time cost is signing in to the tutorial profile per site. The benefit is
that recordings are reproducible and run headlessly in the background.
