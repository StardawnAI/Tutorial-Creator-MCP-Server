# Status Log

Running log: what is done, what is next, decisions and why, known problems.
Newest entry on top.

---

## 2026-08-24 - Server built, tested and registered

### Done

- Built the whole server: environment discovery, browser session, recorder,
  narration, ffmpeg composition, and 16 MCP tools.
- `node scripts/e2e.mjs` - 13/13 checks pass. Records a tutorial against a built-in
  test page and asserts frame rate, size, duration, A/V alignment, listening level,
  subtitles, and that the picture is neither black nor frozen.
- `node scripts/handshake.mjs` - 11/11 checks pass. Completes the MCP handshake,
  lists all 16 tools, and confirms stdout carries only JSON-RPC.
- Registered in `.claude.json` as `tutorial-creator` and verified by launching it
  exactly as Claude Code will.

### Design changes made during the build

**Dropped the hand-written cursor overlay.** Research turned up `page.screencast`
(Playwright 1.59+, present in the installed 1.62.1), which brings an animated
pointer (`showActions`), chapter cards (`showChapter`) and HTML overlays
(`showOverlay`) built in. Roughly 200 lines of my own cursor code deleted in favour
of the API, which also captions each action on screen.

**Switched from `recordVideo` to `page.screencast`.** Both work, but screencast
starts and stops on command, which gives an exact time origin, and it exposes a
quality setting. `recordVideo` remains documented as a fallback.

### Defects found and fixed

1. **The music was inaudible.** A flat `volume=-22dB` on an unknown-loudness source
   produced a mix measured at -41.7 LUFS. Fixed by normalising the music to a target
   loudness first (-32 LUFS under narration, -20 LUFS when it plays alone), which
   makes the result predictable whatever track is supplied. Now measures -21.3 LUFS.
   The e2e test gained a loudness assertion so this cannot come back.

2. **Seven-second start-up.** Binary discovery executed `ffmpeg -version` and
   `ffprobe -version` to test them, costing about 7 seconds - long enough for an MCP
   client to give up. Replaced with a PATH walk: 750 ms.

3. **A broken path in the Claude Code config.** The first write produced
   `C:\Program Files\nodejs\node.exe` with real newlines where backslashes belonged,
   pointing at a file that did not exist. Caught by verifying the written entry
   rather than trusting the write. Rebuilt without escape literals.

### Known problems / open items

- **No ElevenLabs API key.** Narration therefore has never been heard. The whole
  path around it is built and exercised - without a key, `tutorial_say` still paces
  the recording correctly and writes subtitles, it is simply silent. Set
  `ELEVENLABS_API_KEY` in the `tutorial-creator` entry of `.claude.json`.
- **No real logged-in app has been recorded yet.** The e2e test uses a local page.
  A first real run needs `npm run login -- --url <site>` once.
- **Action captions print typed values.** `showActions` writes what was typed into
  the top-right corner, so a verification code would appear on screen. Mitigated by
  `sensitive: true` on `tutorial_type`, which suppresses the caption. Anyone adding
  new action tools must keep this in mind.
- The default narration voice id is a well-known ElevenLabs default and has not been
  confirmed against a live account.

### Next

- Add the API key, then record a real tutorial end to end.
- Restart Claude Code so the tools appear.

---

## 2026-08-23 — Capture strategy settled by experiment

### Done

- Probed the machine: ffmpeg 6.1 (GPL) with `gdigrab`, `ddagrab`, `sidechaincompress`,
  `adelay`, `loudnorm`, `amix` and a native AAC encoder. Node 22.19.0. Playwright
  browsers already installed under `AppData/Local/ms-playwright` (chromium-1234).
- Ran four experiments to decide how to get pictures out of a browser. Results below.
- Scaffolded the project and extracted the background-music audio track.

### Experiments and their outcomes

**1. ffmpeg `gdigrab` window capture (`-i "title=…Google Chrome"`) — FAILED.**
Produces a fully black frame: average luma `YAVG=16`, which is the YUV value for
black, across every frame, and a 2-second clip weighs 7 KB. Chrome composites through
the GPU, so there is nothing for the GDI-based grabber to read. Full-desktop capture
by contrast produced 1.9 MB and `YAVG=49`, i.e. real content.

**2. ffmpeg `gdigrab` region capture — REJECTED.**
Technically works, but it captures whatever is on screen at those coordinates, not
the target window. The test grab of Chrome's rectangle returned a completely
different application that happened to sit in front. That means the machine could
not be used during a recording and any pop-up would land in the video. On a
six-monitor setup with mixed DPI scaling the coordinate maths is fragile too:
`gdigrab` reports the desktop as 10560x4320 while the DPI-aware Win32 API reports
7680x4320, and `offset_x/offset_y` turned out to be absolute virtual-desktop
coordinates, not offsets from the origin.

**3. Attaching to the existing `@playwright/mcp` browser — NOT POSSIBLE.**
That server runs with `--extension`, bridging into the user's real Chrome through
the Playwright browser extension. Its Chromium is launched with
`--remote-debugging-pipe`, not `--remote-debugging-port`, and no debug port is
listening. A second process therefore has no way to speak CDP to that browser, so
the "companion recorder" design is ruled out.

**4. Playwright `launchPersistentContext` + `recordVideo` — CHOSEN.**
Confirmed working headless with a persistent profile, which is what carries the
logins. Output: VP8 webm, 1280x720, **constant 25 fps**, 163 frames over 6.52 s,
514 KB for 6 seconds. A CDP `Page.startScreencast` stream was run against the same
page at the same time and reached 57.8 fps with a 16.7 ms median frame gap, proving
both are available and that they coexist with Playwright driving the page.

Time accuracy was verified with a page counting animation frames: the last frame of
the webm showed `324` and the last screencast frame `325` — a one-frame difference,
so neither method drifts.

### Decisions

**D1 — Orchestrator, not companion.** Our server owns its own Playwright browser
instead of recording one driven by the existing `@playwright/mcp`. Experiment 3
showed the companion model is not merely inelegant, it is impossible with the
current extension-mode setup.

**D2 — `recordVideo` is the primary capture; CDP screencast is the fallback.**
`recordVideo` gives constant 25 fps, time-accurate output and 9x smaller files
(514 KB vs 4.5 MB for the same 6 seconds). 25 fps is ample for a click-through
tutorial. The screencast path stays documented as the option to reach 60 fps if a
recording ever needs it.

**D3 — Headless by default.** The browser is invisible, so recordings run in the
background and the machine stays usable. This is the direct pay-off of dropping
screen capture.

**D4 — Logins come from a dedicated browser profile, not from the real Chrome.**
Copying the live Chrome profile is unreliable on Windows (profile locking, and
Chrome's app-bound cookie encryption). Instead the user signs in once per site in a
headed `login` run against the tutorial profile; the session persists from then on.

**D5 — No browser chrome in the picture.** `recordVideo` captures the viewport only,
so there is no URL bar or tab strip. Rather than a drawback this is treated as a
feature: a clean synthetic browser frame with the current URL can be composited on
top, which looks more consistent than a real window full of the user's own bookmarks
and open tabs.

### Assumptions made (no answer was needed to keep going)

- Narration language defaults to English, matching the repository-wide English rule,
  and is overridable per recording via a parameter.
- Output resolution defaults to 1920x1080 at 25 fps.
- Finished videos are written to `recordings/<slug>/` and returned as a file path;
  uploading anywhere is out of scope.

### Next

- Install dependencies, get a clean build.
- Build the environment doctor, then the browser session layer.

### Known problems / open items

- **No ElevenLabs API key is configured yet.** Nothing in the environment or in
  `.claude.json` carries one. Narration cannot be rendered until it is supplied via
  `ELEVENLABS_API_KEY`. Everything else can be built and tested without it.
- The background-music file is a personal asset and is git-ignored; a fresh clone
  needs its own track.
