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
- [x] The avatar stays on screen between the lines, idling, instead of appearing for
      a few seconds per line
      -> verified: e2e asserts the corner is occupied before, during and after a line,
        and that the spoken clip takes the bubble over while it plays
- [x] The narration voice is a choice: ElevenLabs, or HeyGen's own speech endpoint
      -> verified against the live API: `POST /v3/voices/speech` accepts the request
        (an unknown field returns 400, the real one 402 for credit). The account's
        own voices - including the one the avatar look is paired with - are accepted
        by it too, although the `engine=starfish` listing does not show them
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

## M15 - Looking like a professional tutorial

Asked for as research: what open-source pieces would make the editing and the
animation look like a produced tutorial rather than a screen capture.

The finding worth stating first: almost nothing new is needed. The ffmpeg on this
machine (gyan 7.1 full) carries **libass, xfade, drawtext, minterpolate, frei0r,
libplacebo and libvpx**, and the capture layer already draws rings, instructions,
pointers and camera moves. The gap is not tooling, it is that some of it is unused.

Ordered by what a viewer would notice, against what it costs:

- [x] **Burned-in captions.** The build has libass after all - the note saying it did
      not was written on the previous machine. Written as an ASS file at the video's
      own resolution, kept clear of the avatar's corner.
      -> verified: frames at 21 s and 40.5 s read cleanly over a dark page and over a
        white one; e2e asserts the layout
- [x] **Word-synchronised captions.** Each word lights up as the voice reaches it,
      through ASS karaoke timing (`\k`). The timings come from ElevenLabs' forced
      alignment of the clip that was actually spoken, so they hold for either voice
      source and for recordings made before this existed; without a key they are
      estimated from word length.
      -> verified: all four InStar lines aligned word for word (12, 5, 9 and 10
        words); frames at 6.75 s and 8.9 s show the highlight exactly where the voice
        is; e2e asserts the timing arithmetic and the wrapping
- [x] **A dissolve on every cut.** 0.32 s, and it costs the timeline nothing: the
      outgoing clip is lengthened by a held last frame and the dissolve is laid over
      that, so the incoming clip still starts on the frame the clock says.
      -> verified: the InStar render keeps 1692 frames and 67.68 s with the sound at
        67.69 s; e2e asserts the cut positions and a half-way blend. Three ffmpeg
        traps on the way, each written down in `joinSegments`: xfade restarts its
        clock at the transition, forgets the frame rate, and a hold added after trim
        never arrives unless the rate is declared first
- [x] **A final check that the picture and the sound end together.** The first
      dissolve build froze the picture at the first cut while the file still
      reported its full length. `verifyOutput` now measures each stream on its own.
- [x] **An opening and closing card with motion.** Done with HyperFrames rather than
      Revideo, and the chapter cards with it - see M16.
- [ ] Decide whether the avatar should be able to appear cut out rather than in a
      bubble, for an opening where the person is over the whole frame

### Researched, and what they are worth here

| Tool | Licence | Verdict |
|---|---|---|
| **Revideo** (fork of Motion Canvas) | MIT | The one to reach for if the intro, lower thirds and callouts should be real motion design. TypeScript scenes rendered headlessly to video, composited over our capture. No licence question. |
| **Remotion** | free only for individuals and companies of **up to three people**; otherwise $25/seat/month or $0.01/render with a $100/month minimum | More mature than Revideo, but it is a commercial licence for a company of any size, and this is a product Stardawn ships. Not worth the liability unless Revideo proves insufficient. |
| **editly** | MIT | Declarative ffmpeg editing with gl-transitions and title layers. Solves what `xfade` and `drawtext` already solve for us, and it wants to own the whole render. Skip. |
| **auto-editor** | Unlicense | Cuts silence automatically. We do not have that problem: the recorder cuts waits by the session clock, deliberately, and knows where every line is. Skip. |
| **Whisper / faster-whisper** | MIT | Would give word timings from the audio. Unnecessary - both speech services hand them over for free with the audio they render. |

## M16 - Motion design with HyperFrames

Asked for by name: HeyGen's open-source HTML-to-video renderer (Apache-2.0), to
make the tutorials look produced. Spiked first, on this machine: a templated 4.5 s
intro rendered in 22 s, a transparent lower third came out as ProRes 4444 with
alpha, and a whole 68 s recording pushed through it took 116 s but stayed exact
(PSNR 53 dB against the source, loudness unchanged). So HyperFrames draws the
motion pieces from templates, and the ffmpeg composition stays the backbone - it is
measured, and rebuilding it in HTML would cost render time for nothing.

- [x] Brand the templates after stardawnai.com: colours, typeface, logo
      -> taken from the site's own stylesheet: navy #041422, cyan #01fff4, magenta
        #ff1178, Satoshi (loaded from Fontshare, not committed - its licence does not
        allow redistribution), and the site's white wordmark
- [x] `src/lib/motion.ts`: find the HyperFrames CLI, render a template, cache by
      content, telemetry off, ffmpeg pinned to the configured 7.1, fail soft
      -> verified: e2e renders a real chapter card - 1920x1080, 1.60 s as asked, alpha
        0 at the start and 238 under the veil
- [x] Templates in `assets/motion/`: opening, closing, chapter card. GSAP is taken
      from `node_modules` at render time, not fetched from a CDN
      -> verified: frames of all three looked at; long titles step down to two lines
- [x] Composition: the opening before the recording and the closing after it, both
      dissolving, with the narration, captions and music moved along
      -> verified: e2e 225 frames = 50 + 125 + 50, dissolves at 2.0-2.6 s and
        7.0-7.6 s, caption at 3.00 s for a line at 1.0 s, speech after the opening and
        silence under it. Found on the way: `fps` after a scale drops a stream's last
        frame, so no join may count frames - see ARCHITECTURE §10
- [x] Chapter cards: `tutorial_chapter` records the moment instead of drawing the
      static Playwright card, and the composition lays the animated card over it
      -> verified: e2e shows the half-transparent card at its moment and gone after;
        VP9 WebM instead of ProRes, 0.25 MB against 68 MB, 47 dB apart
- [x] Tool surface: `tutorial_start` `motion`, `tutorial_finish` `opening`,
      `openingSubtitle`, `closing`, `closingTitle`, `closingText`; `recompose.mjs`
      `--cards off`, `--subtitle`, `--closing-title`, `--closing-text`, `--chapter`;
      doctor reports HyperFrames
      -> verified: handshake 11/11 with 22 tools; doctor prints "HyperFrames 0.8.68"
- [x] Optional dependency: a machine without HyperFrames still renders, as today
      -> the e2e recording itself runs without motion and passes; motion is only
        switched on when `motionAvailability()` says it can run
- [x] Real run: the InStar recording re-rendered with opening, two chapters, closing
      -> verified: 76.72 s, 1918 frames = 113 + 1692 + 113, picture and sound end
        together; frames at the opening, a caption, both chapters and the closing
        looked at. `recordings/.../instar-motion.subtitled.mp4`
- [x] README, ARCHITECTURE, STATUS; commit and push

## M17 - The recording itself looks produced

Asked for as "what professional tutorials look like, with clean animations". The cards
of M16 dress the start and the end; the other 90 % of the video was still a raw
full-frame capture. What sets a produced screen tutorial apart (Screen Studio, Arcade,
the launch videos of Linear or Stripe) is the recording itself: the app shown as a
window floating on a branded ground, and every decoration arriving and leaving with
motion rather than blinking on and off.

- [x] A stage: the recording as a window with rounded corners, a soft shadow and a
      slim browser bar naming the site, on the Stardawn ground. Captured at the
      window's own size, so the app stays pixel for pixel sharp
      -> verified: e2e samples the recording inside the window (Y 57), the navy ground
        (Y 32), a rounded-off corner (Y 30, not 57), and a video no longer than before
- [x] The bar follows the page: the host changes when the page navigates or the video
      cuts to another browser - the host only, never a path, which can carry tokens
      -> verified: e2e fingerprints the bar - identical within one site, different
        after the switch; InStar re-rendered switching to instagram.com at the cut
- [x] Decorations in the Stardawn palette, and with an exit as well as an entrance
      -> verified: frames of the live GitHub recording show the cyan ring with its navy
        keyline on a white page, and the instruction card with the cyan-magenta edge
- [x] Keyboard shortcuts shown as keycaps when `tutorial_press` sends one
      -> verified: "Enter ↵" inside the zoomed frame and "/" unzoomed, in the live run.
        The first attempt drew them outside the camera's region
- [x] Shorter cards: 3.5 s opening, 4 s closing
- [x] `tutorial_start` `frame` (default on), `recompose.mjs --frame on|off`,
      `--location`
- [x] Real run: a new framed recording of a real site, and the InStar video framed,
      frames looked at
      -> `recordings/2026-09-25T13-53-25_search-inside-one-github-repository`, and
        `instar-pro.subtitled.mp4` in the InStar folder (1880 frames = 88 + 1692 + 100)
- [x] Found on the way and fixed: the camera stayed zoomed across a page change made
      by a key or a click; Playwright's `Type "…"` captions; the first page loading on
      camera; descenders cut off on the cards
- [x] README, ARCHITECTURE, STATUS; commit and push
- [ ] Pacing: stretches where nothing moves and nobody speaks - a page loading, the
      pause before a click - could be shortened automatically. The GitHub example
      runs 104 s where a produced version would be nearer 70. Deprioritised by the
      user: a speed-up can be applied by hand where it matters

## M18 - Nothing private on camera

Asked for as: cookie banners, the sign-in business, and personal data that has
nothing to do with the tutorial should be recognised and greyed out - "on Facebook or
Instagram, work out from a schema what belongs to the platform and what is private.
A tutorial on commenting shows the post and the comment; going to the messages to
show that something arrived greys out the other messages."

Everything happens in the page itself, before a frame is painted, so private data
never reaches the capture file - not only the finished video.

- [x] Cookie banners answered automatically with "reject", in every page and frame,
      hidden while that happens (DuckDuckGo's autoconsent, 300+ consent tools, among
      them Facebook's, Instagram's and Google's own)
      -> verified live, fresh profile, `scripts/privacy-live.mjs`: 8 of 8 answered
        (Instagram, Facebook, YouTube, Spiegel, Cookiebot, Zeit, LinkedIn, Bahn), and
        all 8 pictures clean at the moment a recording would start. The first
        version filmed Spiegel's banner, which opens 2 s after load; `settle` now
        reads autoconsent's state
- [x] A platform schema (`assets/privacy/platforms.json`): per site, which elements
      are other people's content - messages, conversations, posts, comments,
      notifications, contacts, account choosers, profile pictures - as opposed to the
      platform's own interface. Plus a generic part that works on any site from the
      labels a page gives screen readers (a region labelled "Chats", a feed, a log)
      -> 11 platforms; YouTube and Instagram's public pages checked live. The
        signed-in pages of the others are not checked against a real account
- [x] The veil: those elements are greyed out and blurred, unless the tutorial is
      about them. Pure CSS generated from the schema, so it applies on first paint
      and survives re-renders
      -> verified: edge density of a greyed conversation 0.00 against 11.1 for the
        kept one, in a screenshot and in the capture file
- [x] What the tutorial is about stays visible: whatever is clicked, typed into or
      highlighted keeps its whole item (the post, the conversation, the message);
      `tutorial_privacy` keeps or hides more, and hides given words everywhere
      -> verified: the name inside a conversation keeps the conversation and its
        picture; the YouTube recording highlights the pinned comment, others grey
- [x] Personal data on any site, without a schema: email addresses, phone numbers,
      IBANs, card numbers and API keys in text are covered with a grey bar; personal
      form fields (email, phone, name, address, username, one-time code) show dots
      -> verified: 8 kinds found, 11 look-alikes left alone (versions, dates, prices,
        handles, bad check digits, an ISSN - found live on zeit.de)
- [x] Sign-in clutter: Google's one-tap account chooser hidden, Instagram's "Save
      your login info?" and "Turn on notifications" answered "Not now"
      -> verified on the stand-in; live, Instagram's sign-up wall for visitors is
        closed as well
- [x] Sign-ins off camera: `tutorial_camera` stops putting what happens into the video
      and resumes it, so a login can be done without being filmed
      -> verified: 2 ms of 1200 counted
- [x] `sensitive` typing also greys out the field itself
- [x] `tutorial_start` `privacy` (default on), `cookies`, `hideText`; doctor line
- [x] Real run: a recording with private data and a cookie banner, frames looked at
      -> `examples/pinned-comment-on-youtube.json`, fresh profile:
        `recordings/2026-09-25T17-36-01_find-the-pinned-comment-on-a-youtube-video`
- [x] Found on the way and fixed: every decoration was missing on pages enforcing
      Trusted Types (YouTube, Google's apps); Chromium spent 21 s looking for a proxy
      before its first page
- [x] README, ARCHITECTURE, STATUS; commit and push

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
