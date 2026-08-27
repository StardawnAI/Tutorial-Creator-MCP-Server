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
offsets with `adelay` and summed with `amix`. Each clip is normalised **on its own**
with `loudnorm`, to −16 LUFS with a −1.5 dBFS ceiling. Background music is looped to
length, normalised to −22 LUFS, faded at both ends, and ducked under the voice with
`sidechaincompress` keyed off the narration.

Both of those choices were arrived at by getting them wrong first, and the reasons
are worth stating because neither is obvious.

*Why per clip.* A single `loudnorm` across the assembled timeline does not settle:
the track is mostly silence, a few seconds of speech every ten seconds or so, and a
clip measured at −27.8 LUFS still came out at −23.1 in the finished mix.

*Why loudness normalisation rather than a measured gain.* Speech has a crest factor
around 20 dB — the narration clips here averaged −23.5 LUFS while peaking at
−2.8 dBFS. Reaching −16 LUFS needs +7.5 dB, but only +1.3 dB fits under the ceiling,
so a gain calculation that refuses to clip refuses to do its job: narration landed at
−21.7 LUFS against music at −22.0. Loudness and true peak cannot both be satisfied by
a constant gain, which is precisely the problem `loudnorm` exists to solve.

*Why music sits at −22 and not lower.* Music “in the background” was read as −32 LUFS,
applied whenever narration existed anywhere in the recording — including the opening,
before anyone speaks. That opening measured −31.9 LUFS: inaudible. The ducking is what
makes room for the voice, not the resting level.

Measured on a finished recording: music alone −21.9 LUFS, narration −17.4 LUFS.

**Pass 2 — video and mux.** The stream is made constant-rate with `fps=25`, camera
moves are applied with `zoompan` (§6), the result is transcoded to H.264, the mixed
audio attached as AAC, and `-movflags +faststart` set for web playback. swscale runs
with `lanczos`, since a camera move enlarges pixels and the default scaler makes that
look worse than it needs to.

All required filters are **verified** present in the local ffmpeg 6.1 build:
`adelay`, `amix`, `sidechaincompress`, `loudnorm`, `afade`, `atrim`, `apad`,
`anullsrc`, plus a native `aac` encoder. `libmp3lame` is absent, which does not
matter — mp3 *decoding* works, and AAC covers encoding.

**Note:** `libass` is absent, so the `subtitles=` burn-in filter is unavailable.
Soft subtitles are muxed as `mov_text` instead. Also, `drawtext` font paths need
careful escaping on Windows — a naive path fails to parse.

---

## 6. Showing where to look

A screen recording of an app is a poor teacher on its own: the pointer arrives
somewhere, something changes, and the viewer reconstructs afterwards what was
clicked. Two things fix that, and both run *before* the action.

**Emphasis.** The target is ringed, everything else dimmed by a full-screen scrim,
and an optional caption placed beside it; a pulse marks the moment of contact. All of
it is drawn into the screencast's own overlay layer — never into the page. The
application under demonstration is not modified, which matters: the recording is
supposed to show how the app really behaves.

**Camera moves.** Applied after recording, with `zoompan`, eased in and out. Again
this keeps the page untouched: scaling the document would risk reflowing the very
application being demonstrated and would shift every coordinate. During the session
only the intent is recorded — time, centre, magnification — and `src/lib/zoom.ts`
turns those into one filter expression. `zoompan` honours `ot` to within a frame: a
move scheduled for 4.0 s began at 4.04 s and one scheduled to end at 8.0 s ended at
8.00 s.

The camera **holds its framing** while subsequent actions fall inside the region it is
already showing, and **releases on scroll or navigation**. The recorded centre is a
fixed point in the viewport; once the page moves underneath it, it would frame
whatever happened to slide into that spot.

### What a camera move cannot do

It magnifies the pixels that were captured. It does not add detail.

The obvious way to add detail — capture at twice the output size and crop — does not
work with this API, and it takes a measurement to see that rather than an assumption.
`page.screencast` delivers frames at the CSS viewport size and nothing else: at
viewport 1280x720 with `deviceScaleFactor: 2` the frames still arrive as 1280x720,
byte-for-byte identical to density 1, and asking the screencast for a 2560x1440 `size`
yields a 2560x1440 canvas with the 1280x720 picture sitting unscaled in one corner.
`--force-device-scale-factor=2` changes nothing. `page.screenshot()` *does* honour the
density, which is what makes the assumption so easy to believe — and checking only
that the output file had the requested dimensions confirmed it falsely.

So `MAX_ZOOM` is 1.75, where an enlargement still reads as a deliberate move rather
than as softness, and capture quality is 96 so that what gets enlarged is the picture
rather than compression artefacts. The gain is legibility: text at 1.75x is far easier
to read than the same text at full-page size.

---

## 7. Known risks

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

## 8. Relationship to the existing Playwright MCP

They are independent. The existing `@playwright/mcp` keeps driving the user's real
Chrome for ordinary browsing work. This server has its own browser and its own
profile, because — as established in §2 — it cannot record the other one.

The one-time cost is signing in to the tutorial profile per site. The benefit is
that recordings are reproducible and run headlessly in the background.
