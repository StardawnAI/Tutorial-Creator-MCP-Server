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
- [ ] Record against an app that needs a login
      → needs a one-time `npm run login -- --url <site>`; nothing in the code is
        outstanding for this
- [x] Confirm the tools appear after a full Claude Code restart
      → verified: all 16 tutorial_* tools are exposed in the running session

---

## Deferred / out of scope

- AI-generated background music (a suitable track already exists)
- Uploading finished videos anywhere (a `youtube-pp-cli` MCP already exists)
- Webcam / presenter overlay
- Burned-in subtitles (needs an ffmpeg build with libass; soft subtitles work today)
