# Tutorial Creator MCP Server

Records narrated walkthrough videos of web apps. An agent drives a browser that is
already signed in to your app, speaks over what it is doing, and hands back a
finished mp4 with voice-over, background music and subtitles.

Built for the informative screen recording — *"here is how you verify your account
in this app"* — not for audience-optimised content.

```
tutorial_start  →  tutorial_say / tutorial_click / tutorial_type  →  tutorial_finish
                                                                        ↓
                                                                   tutorial.mp4
```

## How it works

The server runs its own headless Chromium against a saved browser profile. Because
it is headless, recordings run in the background and your machine stays fully
usable — nothing can cover the window, and no notification can wander into the shot.

Narration is generated **before** each line is spoken and the recording then waits
for exactly as long as the speech takes. The video therefore contains precisely the
time the voice needs, so picture and sound cannot drift apart. There is only one
clock.

The design decisions behind this — including the three capture approaches that were
measured and rejected — are in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Requirements

- Node.js 20+
- ffmpeg and ffprobe on `PATH` (needs `adelay`, `amix`, `sidechaincompress`,
  `loudnorm`, `tpad`)
- A Chromium build — `npx playwright install chromium` if you have none
- An ElevenLabs API key for narration (optional: without it, recordings are still
  paced correctly and subtitles are written, they are just silent)

## Setup

```bash
npm install
npm run build
npm run doctor          # reports what is present and what is missing
```

Add a background music track to `assets/music/` — any `.m4a`, `.mp3` or `.wav`. The
first file found is used by default.

### The API key

Put it in a `.env` file in the project root (git-ignored):

```
ELEVENLABS_API_KEY=sk_...
```

The server reads `.env` at start-up. Anything already set in the environment — for
instance in the MCP client's own config — takes precedence over the file.

**The key starts with `sk_`.** It is shown only once, when the key is created or
rotated. The value listed next to a key in the ElevenLabs dashboard is the key
*ID*, not the key, and requests made with it fail. `npm run doctor` calls the API
and tells you which one you have.

### Recording an app you are signed into

The recording browser is a separate browser, so it does not have your logins. It
does not need you to type them in again either — the session is copied across from
the browser you already use.

If a Playwright MCP server is available that drives your real browser, the agent
does this on its own: it opens the site there, exports the session,

```js
await page.goto('https://the-app.com')
await page.context().storageState({ path: '<file>' })
```

and calls `tutorial_import_session` with that path and the domains it needs.

**Open the site before exporting.** `storageState()` only collects page storage
(`localStorage`) for origins that are actually loaded, and many apps keep their
login token there rather than in a cookie. Exporting without opening the site first
yields cookies alone, and the app then looks signed out for no visible reason. The
import tool says so when it happens. The
export is read once and deleted immediately. Pass `verifyUrl` — ideally a page that
requires an account — and the tool confirms the session actually carried before you
spend time recording against it.

Filter by domain. An unfiltered export carries every site you are signed into, and
a tutorial needs one.

**When the transfer cannot work:** a few apps tie their login to the device or
re-check it against a fingerprint. For those, sign in by hand once:

```bash
npm run login -- --url https://app.example.com
npm run login -- --url https://other.example.com --profile work
```

Profiles live in `profiles/` and are git-ignored — they contain live sessions.

### Register with Claude Code

Add to `.claude.json` under `mcpServers`:

```json
{
  "tutorial-creator": {
    "type": "stdio",
    "command": "C:\\Program Files\\nodejs\\node.exe",
    "args": ["<absolute path to>\\Tutorial-Creator-MCP-Server\\dist\\index.js"],
    "env": {
      "ELEVENLABS_API_KEY": "your-key-here"
    }
  }
}
```

New MCP servers need a full restart of Claude Code, not just a window reload.

## Usage

Ask for a tutorial in plain language:

> Record a tutorial showing how to verify an account in our admin app. Start at
> https://app.example.com/settings, walk through entering the email and the
> verification code, and explain each step.

The agent then narrates and clicks its way through, and returns the path to the
finished video.

### Tools

| Tool | Purpose |
|---|---|
| `tutorial_start` | Begin recording — title, starting URL, profile, resolution; `fresh` for an empty browser, `locale` for the page language |
| `tutorial_switch` | Cut to another browser with its own logins, opening it on first use |
| `tutorial_say` | Speak a line; the recording waits for it |
| `tutorial_chapter` | Title card over a blurred backdrop |
| `tutorial_goto` | Navigate |
| `tutorial_click` | Click, after ringing the target and moving the camera to it; `optional` for prompts that only sometimes appear |
| `tutorial_type` | Type into a field; mark `sensitive` for codes and passwords |
| `tutorial_press` | Press a key |
| `tutorial_scroll` | Scroll smoothly, or bring an element into view |
| `tutorial_highlight` | Ring an element and move in on it, without clicking |
| `tutorial_zoom` | Move the camera to a region, or back out to the full page |
| `tutorial_wait` | Hold, optionally until an element appears; `cut` leaves the wait out of the video |
| `tutorial_snapshot` | Read the page as an accessibility tree |
| `tutorial_screenshot` | Look at the page |
| `tutorial_finish` | Stop, mix, render, return the mp4 |
| `tutorial_cancel` | Discard the recording |
| `tutorial_status` | What is being recorded right now |
| `tutorial_voices` | List available narration voices |
| `tutorial_import_session` | Copy a signed-in session in from the browser you already use |
| `tutorial_profiles` | List recording profiles and whether they hold a session |

### Two people in one video

Some things can only be shown from both sides: a business connects its account in
one window, a customer writes to it from another, and the business then sees the
conversation arrive. Each side needs its own logins.

- `tutorial_start` names the first browser (`browser: "business"`). With
  `fresh: true` it starts from an empty throwaway profile — no cookies, no saved
  logins, like a private window — so a real sign-in can be shown. The profile is
  deleted when the recording ends.
- `tutorial_switch` cuts to another browser (`name: "customer"`,
  `profile: "instagram-customer"`), opening it on first use. Opening it and loading
  its first page happen off camera, and switching back later finds it as it was left.
- `tutorial_wait` with `cut: true` leaves a slow reply out of the video: the viewer
  sees the moment before and the moment it arrives. When the reply's wording is
  already further up the conversation from an earlier run, pass `moreThan` with the
  number of matches that were there before, so the wait ends only on a new one.

Every browser is captured continuously from the moment it opens; the recorder notes
which one is on air and when, and the finished video is cut together from exactly
those stretches.

### Composed music

`tutorial_start` with `music: "generate"` has a piece composed for the video when it
is finished, through Google's Lyria model: written to the video's length so it
neither loops nor stops mid-phrase, instrumental, serious and gently accompanying,
with the instrumentation varied from one video to the next. The track library stays
the default, and is used as a fallback if composing fails.

It needs Google access in `.env`: either `GEMINI_API_KEY`, or
`GOOGLE_OAUTH_CLIENT_FILE` (a Google OAuth client file) together with
`GOOGLE_OAUTH_REFRESH_TOKEN`, granted once with the `cloud-platform` and
`generative-language.retriever` scopes. The project behind the client needs the
Generative Language API enabled.

### Keeping secrets out of the video

The recorder captions each action on screen, including typed values — a
verification code would be spelled out in the picture. Pass `sensitive: true` to
`tutorial_type` and the caption is suppressed for that entry.

## Configuration

All optional; sensible defaults apply.

| Variable | Meaning |
|---|---|
| `ELEVENLABS_API_KEY` | Enables spoken narration |
| `TUTORIAL_MCP_MUSIC` | Default music track - a path, or part of a title |
| `TUTORIAL_MCP_VOICE_ID` | Default narration voice |
| `TUTORIAL_MCP_MODEL_ID` | Default TTS model (`eleven_multilingual_v2`) |
| `TUTORIAL_MCP_HOME` | Where `recordings/`, `profiles/` and caches live |
| `TUTORIAL_MCP_CHROMIUM` | Chromium executable, if not auto-detected |
| `FFMPEG_PATH` / `FFPROBE_PATH` | Explicit binary paths |
| `TUTORIAL_MCP_LOG_LEVEL` | `debug`, `info`, `warn`, `error` |

## Output

Each recording gets its own folder under `recordings/`:

```
2026-08-24T10-15-33_verify-your-account/
  tutorial.mp4             ← the deliverable
  tutorial.subtitled.mp4   same video with a soft subtitle track
  raw.webm                 the untouched screen recording
  mix.m4a                  the audio bed on its own, for checking the sound
  captions.srt
  timeline.json            every narration cue and its timestamp
  audio/000.mp3 …          the rendered narration clips
```

Narration is cached by content, so re-recording after fixing one sentence only pays
for the sentence that changed.

## Verifying it works

```bash
node scripts/e2e.mjs
```

Records a short tutorial against a built-in test page and asserts the result:
frame rate, duration, audio/video alignment, listening level, that the music is
audible where nobody is speaking and the voice sits clearly above it, that the camera
measurably magnifies the picture during a move and leaves it untouched before one, and
that the picture is neither black nor frozen.
