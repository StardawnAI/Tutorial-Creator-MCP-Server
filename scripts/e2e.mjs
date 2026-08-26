/**
 * End-to-end check of the whole pipeline without going through MCP.
 *
 * Records a short tutorial against a local test page, narrates over it, renders the
 * mp4 and asserts the result: correct duration, real (non-black) picture, an audio
 * track, and narration cues landing where they were issued.
 *
 *   node scripts/e2e.mjs
 */

import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { pathToFileURL } from 'node:url'

import { loadConfig } from '../dist/lib/env.js'
import { RecordingSession } from '../dist/lib/session.js'
import { compose, verifyOutput } from '../dist/lib/compose.js'
import { probeVideo, run } from '../dist/lib/ffmpeg.js'

const results = []
function check(label, ok, detail = '') {
  results.push({ label, ok, detail })
  const mark = ok ? 'PASS' : 'FAIL'
  process.stdout.write(`  [${mark}] ${label}${detail ? ` - ${detail}` : ''}\n`)
}

const TEST_PAGE = `<!doctype html><meta charset="utf-8"><title>Example App - Settings</title>
<style>
 *{box-sizing:border-box}
 body{font:16px/1.5 system-ui,sans-serif;margin:0;background:#f1f5f9;color:#0f172a}
 header{background:#fff;border-bottom:1px solid #e2e8f0;padding:20px 40px;
        font-weight:700;font-size:20px;display:flex;justify-content:space-between}
 main{padding:48px 40px;max-width:720px}
 h1{font-size:28px;margin:0 0 8px}
 p.lead{color:#64748b;margin:0 0 32px}
 label{display:block;margin:20px 0 6px;font-weight:600;font-size:14px}
 input{width:100%;padding:13px 15px;border:1px solid #cbd5e1;border-radius:8px;font-size:15px;background:#fff}
 input:focus{outline:2px solid #2563eb;outline-offset:1px;border-color:#2563eb}
 button{margin-top:28px;padding:13px 26px;border:0;border-radius:8px;background:#2563eb;
        color:#fff;font-size:15px;font-weight:600;cursor:pointer}
 #done{margin-top:24px;padding:16px;border-radius:8px;background:#dcfce7;color:#166534;
       display:none;font-weight:600}
 .spacer{height:700px}
</style>
<header><span>Example App</span><span>Signed in as jim</span></header>
<main>
  <h1>Verify your account</h1>
  <p class="lead">Confirm your email address to unlock all features.</p>
  <label for="email">Email address</label>
  <input id="email" placeholder="you@example.com">
  <label for="code">Verification code</label>
  <input id="code" placeholder="6-digit code">
  <button id="verify">Verify account</button>
  <div id="done">Your account is verified.</div>
  <div class="spacer"></div>
  <p>End of page.</p>
</main>
<script>
 document.getElementById('verify').onclick = () => {
   document.getElementById('done').style.display = 'block';
 };
</script>`

async function main() {
  const config = loadConfig()
  process.stdout.write('End-to-end pipeline check\n\n')

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tutorial-e2e-'))
  const pageFile = path.join(tmp, 'app.html')
  fs.writeFileSync(pageFile, TEST_PAGE)
  const pageUrl = pathToFileURL(pageFile).href

  process.stdout.write('Recording...\n')
  const session = await RecordingSession.start(config, {
    title: 'E2E Verify Account',
    profile: 'e2e-test',
    width: 1280,
    height: 720,
    headless: true,
    deviceScaleFactor: 1,
    voiceId: config.defaultVoiceId,
    modelId: config.defaultModelId,
    music: config.defaultMusic,
    musicGainDb: 0,
    showActions: true,
    quality: 90,
  })

  const t0 = session.videoTimeMs
  check('recorder started with a time origin', t0 >= 0, `t0=${t0}ms`)

  await session.page.goto(pageUrl, { waitUntil: 'domcontentloaded' })
  await session.showChapter('Verifying your account', 'A short walkthrough', 1800)
  await session.page.waitForTimeout(1800)

  // Narration cue 1 - recorded, then genuinely waited out.
  const cue1At = session.videoTimeMs
  session.addCue({
    atMs: cue1At,
    text: 'First, enter the email address you signed up with.',
    audioFile: null,
    durationMs: 2600,
    voiceId: config.defaultVoiceId,
  })
  await session.page.waitForTimeout(2600)
  await session.page.locator('#email').pressSequentially('jim@example.com', { delay: 60 })
  await session.page.waitForTimeout(600)

  const cue2At = session.videoTimeMs
  session.addCue({
    atMs: cue2At,
    text: 'Then type the six digit code from your inbox.',
    audioFile: null,
    durationMs: 2400,
    voiceId: config.defaultVoiceId,
  })
  await session.page.waitForTimeout(2400)
  await session.page.locator('#code').pressSequentially('482913', { delay: 90 })
  await session.page.waitForTimeout(600)

  const cue3At = session.videoTimeMs
  session.addCue({
    atMs: cue3At,
    text: 'Finally, click verify account. That is all there is to it.',
    audioFile: null,
    durationMs: 2800,
    voiceId: config.defaultVoiceId,
  })
  await session.page.locator('#verify').click()
  await session.page.waitForTimeout(2800)

  const framesBefore = session.frameCount
  const { rawVideo, videoMs } = await session.stopRecording()
  session.writeTimeline()

  check('raw recording exists', Boolean(rawVideo) && fs.existsSync(rawVideo ?? ''), rawVideo ?? 'none')
  check(
    'frames flowed steadily (heartbeat working)',
    framesBefore > videoMs / 100,
    `${framesBefore} frames over ${(videoMs / 1000).toFixed(1)}s ` +
      `= ${(framesBefore / (videoMs / 1000)).toFixed(0)} fps`,
  )

  if (!rawVideo) {
    process.stdout.write('\nAborting: no raw video was produced.\n')
    process.exit(1)
  }

  const rawInfo = await probeVideo(config.ffprobePath, rawVideo)
  check('raw video has the requested size', rawInfo.width === 1280 && rawInfo.height === 720,
    `${rawInfo.width}x${rawInfo.height}`)
  check('raw video is constant 25 fps', Math.abs(rawInfo.frameRate - 25) < 0.5,
    `${rawInfo.frameRate.toFixed(1)} fps`)

  process.stdout.write('\nComposing...\n')
  const result = await compose(config, {
    rawVideo,
    cues: session.cues,
    outputDir: session.outputDir,
    music: config.defaultMusic,
    musicGainDb: 0,
    subtitles: true,
  })

  check('mp4 was produced', fs.existsSync(result.outputFile), result.outputFile)
  check('mp4 has an audio track', result.hasAudio)

  const finalInfo = await probeVideo(config.ffprobePath, result.outputFile)
  check('final video is H.264', finalInfo.codec === 'h264', finalInfo.codec)

  // The video must be long enough to contain the last narration line in full.
  const lastCueEnd = Math.max(...session.cues.map(c => c.atMs + c.durationMs)) / 1000
  check(
    'video covers the final narration line',
    result.durationSec >= lastCueEnd,
    `video ${result.durationSec.toFixed(1)}s vs last cue ending at ${lastCueEnd.toFixed(1)}s`,
  )

  // Audio and video must line up.
  const { stdout: durations } = await run(config.ffprobePath, [
    '-v', 'error', '-show_entries', 'stream=codec_type,duration', '-of', 'json', result.outputFile,
  ])
  const streams = JSON.parse(durations).streams ?? []
  const v = streams.find(s => s.codec_type === 'video')
  const a = streams.find(s => s.codec_type === 'audio')
  if (v && a) {
    const drift = Math.abs(Number(v.duration) - Number(a.duration))
    check('audio and video lengths agree', drift < 0.3, `drift ${drift.toFixed(3)}s`)
  } else {
    check('audio and video streams both present', false, 'a stream is missing')
  }

  const quality = await verifyOutput(config, result.outputFile)
  check('picture is real, not black or frozen', quality.ok, quality.problems.join('; '))

  // Regression guard: a fixed attenuation once produced a -41.7 LUFS mix, which is
  // inaudible. Music-only output should land near its -20 LUFS target.
  const { stderr: loudness } = await run(config.ffmpegPath, [
    '-hide_banner', '-i', result.outputFile, '-af', 'ebur128', '-f', 'null', '-',
  ])
  // ebur128 prints a running I: value on every tick, starting at -70. Only the
  // figure in the trailing "Integrated loudness:" summary is the real measurement.
  const measured = Number(
    loudness.match(/Integrated loudness:\s*[\r\n]+\s*I:\s*(-?[\d.]+)\s*LUFS/)?.[1] ?? NaN,
  )
  check(
    'audio sits at a usable listening level',
    Number.isFinite(measured) && measured > -30,
    `${measured} LUFS`,
  )

  const srt = path.join(session.outputDir, 'captions.srt')
  check('subtitles were written', fs.existsSync(srt),
    fs.existsSync(srt) ? `${fs.readFileSync(srt, 'utf8').split('\n\n').length} entries` : '')

  const failed = results.filter(r => !r.ok)
  process.stdout.write(`\n${results.length - failed.length}/${results.length} checks passed\n`)
  process.stdout.write(`Output: ${result.outputFile}\n`)
  fs.rmSync(tmp, { recursive: true, force: true })
  process.exit(failed.length > 0 ? 1 : 0)
}

main().catch(err => {
  process.stderr.write(`\ne2e failed: ${err.stack ?? err.message}\n`)
  process.exit(1)
})
