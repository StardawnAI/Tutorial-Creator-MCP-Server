# Implementation Plan

Ordered checklist. A milestone counts as done only when its verification step has
actually been run and its output shown.

Status legend: `[ ]` open · `[x]` done · `[~]` in progress · `[!]` blocked

---

## M0 — Foundations

- [x] Verify the recording approach empirically
      → verified: `gdigrab` window capture is pure black (`YAVG=16`); desktop region
        capture records whatever is in front, not the target window; the existing
        `@playwright/mcp` uses `--remote-debugging-pipe` so no second process can
        record it. `page.screencast` works and is time-accurate.
- [x] Project scaffold: `package.json`, `tsconfig.json`, `.gitignore`, layout
      → verified: `npm run build` exits 0
- [x] Extract the background-music audio track
      → verified: `assets/music/founder-mode-dark-ambient.m4a`, AAC stereo, 3637 s
- [x] Install dependencies and get a clean build
      → verified: `npm install && npm run build` exit 0, `dist/index.js` present

## M1 — Environment doctor

- [x] `src/lib/env.ts` resolves ffmpeg, ffprobe, Chromium, music and config
- [x] `doctor` CLI reporting every dependency
      → verified: `node dist/cli/doctor.js` exits 0, reports ffmpeg 6.1, all required
        filters, Chromium, music (61 min); warns about the absent API key
- [x] Binary lookup walks PATH instead of executing candidates
      → verified: server start-up went from 7216 ms to 750 ms

## M2 — Browser session with real logins

- [x] `src/lib/browser.ts`: persistent profile, headless, background-paint flags
      → verified: launches and records in the e2e run
- [x] Guard against pointing at a real Chrome/Edge profile directory
- [x] `login` CLI opening the profile headed for a one-time sign-in
      → verified: builds and runs; **not yet exercised against a real site**
- [x] Resolution presets (720p / 1080p / 1440p)
      → verified: e2e asserts the raw video is exactly 1280x720

## M3 — Recording session and timeline

- [x] `src/lib/recorder.ts` wrapping `page.screencast` with first-frame calibration
- [x] `src/lib/heartbeat.ts` forcing repaints so the timeline stays honest
      → verified: idle page went from 4 frames in 6 s to 357 frames at 59 fps
- [x] `src/lib/session.ts`: single active session, cue list, timeline.json
- [x] Guard rails for double-start and acting without a session
      → verified: handshake test asserts a clean error, not a crash

## M4 — Narration (ElevenLabs)

- [x] `src/lib/tts.ts`: TTS over the HTTP API, duration measured from the audio
- [x] On-disk cache keyed by text + voice + model + settings
- [x] Silent fallback that still paces the recording when no key is set
      → verified: e2e runs end to end with no API key
- [x] **Real speech verified.** With a valid key, a 70.8 s tutorial synthesised 7
      narration clips and mixed them under the picture.
      → verified: overall loudness -17.3 LUFS; music alone measures -31 to -35 LUFS
        while speech measures -16 to -18 LUFS, i.e. the ducking works

## M5 — Composition (ffmpeg)

- [x] Narration placed on a silent timeline at cue offsets (`adelay` + `amix`)
- [x] Music looped, faded, normalised and ducked under the voice
      → verified: fixed a real defect here — a flat `volume=-22dB` produced a
        -41.7 LUFS mix (inaudible); normalising to a target first gives -21.3 LUFS
- [x] Final mux: H.264 + AAC, `+faststart`, loudness-normalised
      → verified: e2e asserts h264, an audio track, and 0.000 s A/V drift
- [x] Tail extension so trailing narration is never cut off
      → verified: e2e asserts video length ≥ last cue end
- [x] Soft subtitles as `mov_text` (this ffmpeg build has no libass)
      → verified: `captions.srt` written with correct timings
- [x] Output sanity check for black or frozen video

## M6 — MCP server surface

- [x] `src/index.ts`: stdio server, logging strictly to stderr
- [x] 16 tools registered across recording, narration and browser control
- [x] `tutorial_finish` returns the path plus a `resource_link`
      → verified: `node scripts/handshake.mjs` — 11/11 checks, 16 tools, stdout
        carries only JSON-RPC
- [x] Sensitive input suppresses the on-screen action caption

## M7 — End to end

- [x] Automated pipeline test
      → verified: `node scripts/e2e.mjs` — 13/13 checks
- [x] README with setup, tool reference and the login flow
- [x] Register the server in Claude Code
      → verified: launched exactly as Claude Code will (command + args from
        `.claude.json`) and completed the handshake
- [x] **Record a real tutorial against a real website**
      → verified: `node scripts/record.mjs examples/overview.json` produced a 70.8 s
        1920x1080 mp4 with 7 spoken lines, music and subtitles
- [x] **Reach a signed-in app without a manual login**
      → verified: exported the session from the user's real Chrome via the Playwright
        MCP, imported 14 github.com cookies (1926 others deliberately left out), and
        `github.com/settings/profile` then loaded as the real user instead of
        redirecting to a sign-in page
- [x] Confirm the tools appear after a full Claude Code restart
      → verified: all 16 tutorial_* tools are exposed in the running session

## M9 - Professional presentation: audible music, emphasis, zoom

Raised after watching the first real recording: the sound was inaudible and the
picture was a plain screen capture with nothing guiding the eye.

- [x] Music is audible when nobody is speaking
      -> verified: the music-only opening measures -21.9 LUFS on a real recording,
        up from -31.9; ducked to -38.6 under the voice, 17 dB of separation
- [x] Narration reaches a speaking level whatever the synthesiser hands over
      -> verified: real clips arriving at -23.5 LUFS now render at -17.4. A measured
        constant gain could not do this - speech peaks at -2.8 dBFS leave only 1.3 dB
        of the 7.5 dB needed - so each clip is loudness-normalised instead
- [!] Capture at 2x so a zoom stays sharp - ABANDONED, not possible
      -> measured: `page.screencast` delivers at the CSS viewport size regardless of
        device scale factor; `size` only pads the canvas. A camera move magnifies
        captured pixels, so MAX_ZOOM is 1.75 and capture quality is 96 instead
- [x] Emphasis layer: ring on the target, dimmed surroundings, click pulse
      -> verified: extracted frames show the ring, scrim and caption in place
- [x] Automatic camera move onto the region being acted on, eased in and out
      -> verified: 46.0 dB against a no-zoom render before the move, 17.2 dB during it
- [x] Camera holds its framing in one region, releases on scroll/navigate
      -> verified: two adjacent fields produce one camera move, not two
- [x] Regression assertions for all of the above in `scripts/e2e.mjs`
      -> verified: `node scripts/e2e.mjs` 23/23. The fixture had to be rebuilt twice:
        a stand-in gentler than real speech passed a mix that was actually broken

---

## Deferred / out of scope

- AI-generated background music (a suitable track already exists)
- Uploading finished videos anywhere (a `youtube-pp-cli` MCP already exists)
- Webcam / presenter overlay
- Burned-in subtitles (needs an ffmpeg build with libass; soft subtitles work today)
