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

## M10 - Real instructions, and music worth listening to

Raised after watching the first recording with camera moves: the emphasis captions
repeated what the button already said, and the music was unusable.

- [x] Replace the caption pinned to the target with an instruction in the margin
      -> verified: extracted frames show the card opposite the target with a line
        drawn to it; e2e asserts the card never overlaps what it points at
- [x] Show the instruction in the wide shot, before the camera moves in
      -> verified: frame at 23.0s of the GitHub recording, whole page still in frame
- [x] Replace the background music and cut it into selectable tracks
      -> verified: 20 tracks in assets/music, chosen per recording by name
- [x] Strip each track's silent lead-in
      -> verified: the chosen track went from -55 dB in its first three seconds to
        level with its own average
- [x] Level music by measured gain rather than loudnorm
      -> verified: opening went from -27.0 to -22.8 LUFS on a real recording
- [x] An example that teaches something instead of describing the recorder
      -> verified: examples/find-code-on-github.json, 93 s, a real signed-in walk
        through GitHub's repository-scoped search
- [x] Clear the recordings folder
      -> verified: 121 MB freed, 19 old runs removed

## M11 - Two people in one video

Raised by a Meta App Review screencast: a business signs in and connects its
Instagram account in one browser, a customer comments and chats in another, and the
video cuts between them. The replies take up to two minutes to arrive, and that
wait must not be in the video.

- [x] A recording is cut together from stretches of continuous capture, one per
      browser, joined at exactly the lengths the session clock gave them
      -> verified: restarting a capture per cut was tried first and is broken - a
        second screencast on the same page opened with 4 s of stale frames
- [x] Several named browsers per recording, each with its own profile or an empty
      throwaway one (a private window), switched with `tutorial_switch`
- [x] `tutorial_wait` can leave the wait out of the video (`cut: true`), and wait for
      a new match when old ones are already on the page (`moreThan`)
- [x] `tutorial_click` can skip a prompt that only sometimes appears (`optional`)
- [x] English page language on request, so an English tutorial shows an English UI
- [x] Regression checks: browsers do not share cookies, a cut removes its time, and
      the picture changes browser exactly where the timeline says it does
      -> verified: `node scripts/e2e.mjs` 33/33, handshake 11/11 with 20 tools
- [!] Record the InStar Instagram App Review screencast with it and look at the frames
      -> blocked: Meta shows a reCAPTCHA after the automated Instagram login. It needs
        a person at the machine; the script waits for it and cuts the wait

## M12 - Always a finished video, and generated music

Raised after four InStar attempts produced nothing but raw captures: no sound, an
hour long, and nothing after the security check was answered.

- [x] Delete the failed attempts
      -> verified: four folders removed, only the two August GitHub videos remain
- [x] A recording that fails is still rendered as a finished video with voice and
      music - raw captures are never the hand-over
      -> verified: the InStar run stopped before the Instagram login rendered a
        67.7 s mp4 with 4 narration lines, music and 5 camera moves
- [x] Waiting for a person is capped at minutes, not an hour (10 min)
- [ ] After the security check, carry on instead of stopping: start the connection
      again from InStar when Instagram lands on its feed
      -> built into the recording script; not yet exercised live
- [ ] When a person is needed, the recorder window comes to the front
      -> built (a plain SetForegroundWindow was refused by Windows; a synthetic Alt
        press first is the documented way round); not yet exercised live
- [x] Short narration lines reach speaking level
      -> verified: lines of 1.4 to 2.9 s went from -22.5/-21.4/-20.7 to
        -17.1/-17.1/-16.5 LUFS; e2e asserts a 1.4 s line
- [x] `scripts/recompose.mjs` renders an existing recording again from its timeline
      -> verified: the InStar video re-rendered with the fixed mix in about a minute
- [~] Generated background music (Gemini / Lyria) as a second path beside the
      track library: sized to the video, serious and gently accompanying, different
      every time
      -> built and the brief is asserted in e2e; waiting on the one-time Google
        consent for the Stardawn OAuth client before it can be heard
- [ ] Record the InStar Instagram App Review video in full

## M13 - An avatar speaks the narration (HeyGen)

Asked for after seeing a photo avatar in the HeyGen app: the same tutorial, but with
a person in the corner saying the lines, instead of a disembodied voice.

- [x] `src/lib/avatar.ts` against the current HeyGen API (v3; v2 is retired
      2026-10-31): upload the narration clip, render the look speaking it, poll,
      download
      -> verified: every endpoint exercised against the live account - upload
        (`POST /v3/assets`) returns an asset id, looks resolve by id, by group id and
        by name, and `POST /v3/videos` reaches the credit check, which it can only do
        after the request schema has been accepted (an unknown field returns 400)
- [x] The narration stays ElevenLabs. The avatar is lip-synced to the audio the
      video already carries, so the voice, its level and the ducking are untouched
- [x] Clips are cached by audio + look, so re-rendering a recording costs no credits
- [x] `tutorial_start` takes `avatar`, `avatarCorner` and `avatarSize`; an unknown
      look or a missing key fails at the start, not after the recording
- [x] `tutorial_avatars` lists the looks on the account
      -> verified: handshake lists 22 tools; the account's own group returns 9 looks
- [x] Composition: round presenter bubble over the finished picture, faded in and
      out per line, never touched by the camera moves
      -> verified: the InStar recording re-rendered with four bubbles in 12 s; frames
        at 7.5 s, 15 s and 41 s show the bubble present, absent, and unmagnified
        while the camera is in
- [x] `scripts/recompose.mjs --avatar <look>` puts an avatar on a finished recording
      -> also fixed there: a recording whose folder has moved is found again by its
        own files, which every recording made before this project was renamed needs
- [x] Regression checks in `scripts/e2e.mjs`
      -> verified: 48/48. The first version of the bubble check passed a render with
        no bubble in it - an output `-ss` discards frames only after the filter chain
        has run, so it measured the frame at zero every time
- [!] Verified against the real API end to end
      -> blocked: the HeyGen account (media@ke.nf) has a wallet balance of 0, so
        every render is refused with `insufficient_credit`. Everything up to the
        render is verified against the live API; the compositing is verified with
        stand-in clips

## M14 - Bot checks and two-factor

The blocker on the InStar recording, and on every app worth filming: the sign-in is
defended. Separated by what is actually solvable.

- [x] Do not look like a robot: automation flags off, a real user agent, a profile
      with history, human typing and mouse movement
      -> verified: e2e asserts the user agent no longer says "HeadlessChrome",
        `navigator.webdriver` is false as in a browser a person drives, and
        `window.chrome` exists. Typing was already character by character
- [x] Sign in once by hand, record forever: `tutorial_import_session` is the answer
      whenever the login itself does not have to be on camera
      -> already built (M7); now written down as the first thing to reach for
- [x] Two-factor by TOTP app: compute the six digits from the shared secret and type
      them, so an authenticator app is no obstacle
      -> verified: `src/lib/totp.ts` reproduces all four RFC 6238 test vectors; the
        secret is read from a named environment variable, never from a tool call
- [x] A pause for a person: bring the window forward, say on screen what is needed,
      wait for the page to change, and cut the wait out of the video
      -> verified: `tutorial_handoff` raised a real headed window (the foreground
        window afterwards was the recorder's) and showed and removed its banner.
        A plain SetForegroundWindow is refused by Windows; a synthetic Alt press
        first is the documented way round, and PowerShell needs the script in a
        file - as one `-Command` argument the C# block loses a quote and dies
- [x] Written down in the README: what this beats, and what it cannot
- [ ] Record the InStar Instagram App Review video with the handoff tool

---

## Later

- **Take a written guide by URL.** Point the server at a Markdown document - a
  GitHub URL, say - and have it read the guide and record it as a tutorial, rather
  than the steps being dictated in the conversation. Assumes the recording profile
  already carries the necessary sign-in.

---

## Deferred / out of scope

- AI-generated background music (a suitable track already exists)
- Uploading finished videos anywhere (a `youtube-pp-cli` MCP already exists)
- Webcam / presenter overlay
- Burned-in subtitles (needs an ffmpeg build with libass; soft subtitles work today)
