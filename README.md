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
does this on its own: it exports the session there,

```js
await page.context().storageState({ path: '<file>' })
```

and calls `tutorial_import_session` with that path and the domains it needs. The
export is read once and deleted immediately. Pass `verifyUrl` — ideally a page that
requires an account — and the tool confirms the session actually carried before you
spend time recording against it.

Filter by domain. An unfiltered export carries every site you are signed into, and
a tutorial needs one.

**When the transfer cannot work:** some apps keep their login in `localStorage`
rather than cookies, or tie it to the device. For those, sign in by hand once:

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
| `tutorial_start` | Begin recording — title, starting URL, profile, resolution |
| `tutorial_say` | Speak a line; the recording waits for it |
| `tutorial_chapter` | Title card over a blurred backdrop |
| `tutorial_goto` | Navigate |
| `tutorial_click` | Click, with the pointer gliding to the target |
| `tutorial_type` | Type into a field; mark `sensitive` for codes and passwords |
| `tutorial_press` | Press a key |
| `tutorial_scroll` | Scroll smoothly, or bring an element into view |
| `tutorial_highlight` | Outline an element to draw the eye |
| `tutorial_wait` | Hold, optionally until an element appears |
| `tutorial_snapshot` | Read the page as an accessibility tree |
| `tutorial_screenshot` | Look at the page |
| `tutorial_finish` | Stop, mix, render, return the mp4 |
| `tutorial_cancel` | Discard the recording |
| `tutorial_status` | What is being recorded right now |
| `tutorial_voices` | List available narration voices |
| `tutorial_import_session` | Copy a signed-in session in from the browser you already use |
| `tutorial_profiles` | List recording profiles and whether they hold a session |

### Keeping secrets out of the video

The recorder captions each action on screen, including typed values — a
verification code would be spelled out in the picture. Pass `sensitive: true` to
`tutorial_type` and the caption is suppressed for that entry.

## Configuration

All optional; sensible defaults apply.

| Variable | Meaning |
|---|---|
| `ELEVENLABS_API_KEY` | Enables spoken narration |
| `TUTORIAL_MCP_VOICE_ID` | Default narration voice |
| `TUTORIAL_MCP_MODEL_ID` | Default TTS model (`eleven_multilingual_v2`) |
| `TUTORIAL_MCP_MUSIC` | Background music file, overriding the `assets/music` default |
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
frame rate, duration, audio/video alignment, listening level, and that the picture
is neither black nor frozen.
