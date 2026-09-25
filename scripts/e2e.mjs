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
import http from 'node:http'
import path from 'node:path'
import os from 'node:os'
import { pathToFileURL } from 'node:url'

import { loadConfig } from '../dist/lib/env.js'
import { RecordingSession } from '../dist/lib/session.js'
import {
  AVATAR_SIZE,
  TRANSITION_SECONDS,
  avatarOverlayFilters,
  buildAss,
  compose,
  karaokeText,
  narrationChain,
  verifyOutput,
} from '../dist/lib/compose.js'
import { estimateTimings } from '../dist/lib/words.js'
import { fillTemplate, motionAvailability, renderMotion } from '../dist/lib/motion.js'
import { hostOf, stageComposition, stageLayout } from '../dist/lib/stage.js'
import { spotlight, ripple, instruct, instructionLayout, keycaps } from '../dist/lib/emphasis.js'
import { probeVideo, run } from '../dist/lib/ffmpeg.js'
import { musicPrompt } from '../dist/lib/music-gen.js'
import { launchBrowser } from '../dist/lib/browser.js'
import { createDetector, describePrivacy } from '../dist/lib/privacy.js'
import { currentCode, secondsLeft, totp } from '../dist/lib/totp.js'

const OUT_W = 1280
const OUT_H = 720
const CAPTURE_SCALE = 1

/**
 * A stand-in for a narration clip.
 *
 * The mixing chain is what is under test, not the speech synthesiser, so the check
 * must not depend on an API key or on the network.
 *
 * Its shape matters more than it looks, and getting it wrong hid a real defect twice.
 *
 * Version one was plain band-limited noise: quiet, even, about 9 dB between its
 * average level and its peaks. Real speech is nothing like that - the ElevenLabs
 * clips measured -23.5 LUFS against peaks of -2.8 dBFS, a spread of over 20 dB - and
 * that spread is precisely what defeats a naive gain calculation. The smooth stand-in
 * sailed through, so the suite reported a healthy mix while real recordings came out
 * with the voice buried under the music.
 *
 * Version two added a sharp transient for the spread but left the noise steady, which
 * measures a loudness range of exactly zero. No real recording does, and `loudnorm`
 * treats that as a special case: it drops to linear normalisation and gives up at the
 * peak ceiling. The stand-in now failed a mix that was actually correct.
 *
 * So all three properties have to hold together: a level well below target, peaks
 * near the ceiling, and a loudness range that varies the way speech does. Quiet pink
 * noise, slowly swelling, with one sharp transient on top.
 */
async function speechStandIn(config, file, seconds) {
  await run(config.ffmpegPath, [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', `anoisesrc=d=${seconds}:c=pink:a=0.6:r=44100`,
    '-f', 'lavfi', '-i', `aevalsrc='0.95*sin(2*PI*900*t)*exp(-260*t)':d=${seconds}:s=44100`,
    '-filter_complex',
    '[0:a]highpass=f=180,lowpass=f=3400,tremolo=f=1.2:d=0.9[n];' +
      '[n][1:a]amix=inputs=2:normalize=0,aformat=channel_layouts=stereo[a]',
    '-map', '[a]', '-c:a', 'aac', '-b:a', '128k',
    file,
  ])
  return file
}

/** Integrated loudness of a slice, in LUFS. */
async function loudnessOf(config, file, startSec, lengthSec) {
  const { stderr } = await run(config.ffmpegPath, [
    '-hide_banner', '-nostats',
    '-ss', String(startSec), '-t', String(lengthSec),
    '-i', file, '-af', 'ebur128', '-f', 'null', '-',
  ])
  // Only the trailing summary is the real measurement; the running I: values start
  // at -70 and would match first.
  const m = stderr.match(/Integrated loudness:\s*[\r\n]+\s*I:\s*(-?[\d.]+)\s*LUFS/)
  return m ? Number(m[1]) : NaN
}

/** Drive one target exactly as the click tool does: instruct wide, then move in. */
async function frameAndMark(session, selector, instruction) {
  const locator = session.page.locator(selector)
  await locator.scrollIntoViewIfNeeded({ timeout: 10_000 })
  const box = await locator.boundingBox({ timeout: 10_000 })
  if (instruction) {
    const shown = await instruct(session.page, box, instruction)
    await session.page.waitForTimeout(shown)
  }
  const scale = session.focusOn(box, instruction ?? 'action')
  await spotlight(session.page, box, { durationMs: 1500 })
  await session.page.waitForTimeout(1000)
  return { box, scale }
}

/** Do two rectangles share any area? */
function overlaps(a, b) {
  return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height
}

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

/**
 * Two browsers in one recording, and a wait left out of it.
 *
 * Each page is one flat colour, so the finished video can be read back to see which
 * browser is on screen when: light for the "business", dark for the "customer", and
 * mid grey for what the customer's page turns into while nothing is being recorded.
 * Joined at the wrong lengths, or with the cut keeping its time, the colour would
 * change somewhere other than where the session clock says it did.
 */
async function twoBrowsers(config) {
  process.stdout.write('\nTwo browsers and a cut...\n')

  const server = http.createServer((req, res) => {
    const colour = req.url === '/dark' ? '#0f172a' : '#f8fafc'
    res.setHeader('content-type', 'text/html')
    res.end(`<!doctype html><title>${req.url}</title><body style="margin:0;background:${colour}">`)
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${server.address().port}`
  const throwaways = () =>
    fs.readdirSync(os.tmpdir()).filter(n => n.startsWith('tutorial-fresh-')).length
  const throwawaysBefore = throwaways()

  const session = await RecordingSession.start(config, {
    title: 'E2E Two Browsers',
    profile: 'e2e-test',
    browserName: 'business',
    width: OUT_W,
    height: OUT_H,
    headless: true,
    deviceScaleFactor: 1,
    voiceId: config.defaultVoiceId,
    modelId: config.defaultModelId,
    music: null,
    musicGainDb: 0,
    showActions: false,
    quality: 90,
    emphasis: false,
    autoZoom: false,
  })

  await session.page.goto(`${base}/light`)
  await session.page.evaluate(() => { document.cookie = 'who=business; path=/' })
  await session.page.waitForTimeout(1500)

  const switchAt = session.videoTimeMs
  await session.switchTo('customer', { fresh: true, url: `${base}/dark` })
  check(
    'opening a second browser takes no video time',
    session.videoTimeMs - switchAt < 400,
    `${session.videoTimeMs - switchAt}ms`,
  )
  const customerCookies = await session.page.evaluate(() => document.cookie)
  check(
    "a fresh browser does not see the other browser's cookies",
    customerCookies === '',
    customerCookies ? `saw "${customerCookies}"` : 'none',
  )
  await session.page.waitForTimeout(1500)

  const cutAt = session.videoTimeMs
  const cutStarted = Date.now()
  await session.offCamera(async () => {
    await session.page.evaluate(() => { document.body.style.background = '#808080' })
    await new Promise(resolve => setTimeout(resolve, 4000))
  })
  const waited = Date.now() - cutStarted
  check(
    'a cut leaves its time out of the video',
    waited >= 4000 && session.videoTimeMs - cutAt < 400,
    `${(waited / 1000).toFixed(1)}s waited, ${session.videoTimeMs - cutAt}ms of video`,
  )
  await session.page.waitForTimeout(1500)

  const backAt = session.videoTimeMs
  await session.switchTo('business')
  const businessCookies = await session.page.evaluate(() => document.cookie)
  check(
    'switching back finds the first browser as it was left',
    businessCookies.includes('who=business'),
    businessCookies || 'no cookies',
  )
  await session.page.waitForTimeout(1500)

  const { segments, videoMs } = await session.stopRecording()
  server.close()
  check(
    'the throwaway profile is deleted afterwards',
    throwaways() === throwawaysBefore,
    `${throwaways() - throwawaysBefore} left behind`,
  )
  check(
    'every cut started a new segment',
    segments.length === 4,
    segments.map(s => `${s.browser} ${(s.durationMs / 1000).toFixed(2)}s`).join(', '),
  )

  const result = await compose(config, {
    rawVideo: segments,
    cues: [],
    outputDir: session.outputDir,
    outputName: 'two-browsers.mp4',
    outputWidth: OUT_W,
    outputHeight: OUT_H,
    music: null,
    musicGainDb: 0,
    subtitles: false,
  })
  check(
    'the joined video is as long as the recorded timeline',
    Math.abs(result.durationSec - videoMs / 1000) < 0.1,
    `${result.durationSec.toFixed(2)}s vs ${(videoMs / 1000).toFixed(2)}s recorded`,
  )

  // Seek with trim inside the filter chain. An output -ss drops frames only after
  // they have been through the filters, so signalstats reports the first frame of
  // the file whatever the requested time - which read every moment as the opening.
  const lumaAt = async seconds => {
    const { stderr } = await run(config.ffmpegPath, [
      '-hide_banner', '-v', 'info', '-i', result.outputFile, '-frames:v', '1',
      '-vf',
      `trim=start=${seconds.toFixed(3)},scale=64:36,signalstats,` +
        'metadata=print:key=lavfi.signalstats.YAVG',
      '-f', 'null', '-',
    ])
    return Number(stderr.match(/YAVG=([0-9.]+)/)?.[1] ?? NaN)
  }
  // Every cut is now a dissolve that starts on the cut, so "after" is measured once
  // it has finished; the middle of it is checked separately below.
  const fade = TRANSITION_SECONDS * 1000
  const looks = { light: y => y > 200, dark: y => y < 60, grey: y => y > 100 && y < 160 }
  const moments = [
    ['business before the first cut', switchAt - 200, 'light'],
    ['customer once the dissolve is over', switchAt + fade + 200, 'dark'],
    ['customer just before the wait', cutAt - 200, 'dark'],
    ['customer once the dissolve after the wait is over', cutAt + fade + 200, 'grey'],
    ['customer before switching back', backAt - 200, 'grey'],
    ['business once the dissolve is over', backAt + fade + 200, 'light'],
  ]
  const wrong = []
  for (const [label, ms, want] of moments) {
    const y = await lumaAt(ms / 1000)
    if (!looks[want](y)) wrong.push(`${label}: luma ${y.toFixed(0)}, expected ${want}`)
  }
  check(
    'each cut lands where the clock says it does',
    wrong.length === 0,
    wrong.length ? wrong.join('; ') : `${moments.length} moments checked around ${moments.length / 2} dissolves`,
  )

  // Halfway through the first dissolve the picture is neither window but both.
  const midway = await lumaAt((switchAt + fade / 2) / 1000)
  check(
    'a cut between browsers is a dissolve, not a jump',
    midway > 70 && midway < 190,
    `luma ${midway.toFixed(0)} halfway through, between light (>200) and dark (<60)`,
  )
}

/**
 * The avatar bubble: on screen while the line plays, gone either side of it, and
 * never over the rest of the picture.
 *
 * Rendered from a stand-in clip rather than from HeyGen. What is under test is the
 * compositing - where the bubble sits, when it appears, what it leaves alone - and
 * that must not depend on an API key, on credit, or on the network.
 */
async function avatarBubble(config) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-avatar-'))
  const base = path.join(dir, 'base.mp4')
  const clip = path.join(dir, 'clip.mp4')

  await run(config.ffmpegPath, [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', `color=c=0x303030:s=${OUT_W}x${OUT_H}:r=25:d=6`,
    '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', base,
  ])
  await run(config.ffmpegPath, [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', 'color=c=white:s=720x720:r=25:d=2',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', clip,
  ])

  const result = await compose(config, {
    rawVideo: base,
    cues: [],
    outputDir: dir,
    music: null,
    musicGainDb: 0,
    subtitles: false,
    outputWidth: OUT_W,
    outputHeight: OUT_H,
    avatarClips: [{ file: clip, atMs: 2000, durationMs: 2000 }],
  })

  // Where the default bubble lands: 18% of the width across, 2.5% in from the corner.
  const diameter = Math.round((OUT_W * AVATAR_SIZE) / 2) * 2
  const margin = Math.round(OUT_W * 0.025)
  const corner = `${diameter}:${diameter}:${OUT_W - diameter - margin}:${OUT_H - diameter - margin}`
  const elsewhere = `${OUT_W / 2}:${OUT_H}:0:0`

  // Sampled with `trim`, not with `-ss`. An output seek discards its frames only
  // after the filter chain has run, so `signalstats` would report the frame at zero
  // however late the moment asked for - which it duly did, and passed a render with
  // no bubble in it at all.
  const lumaOf = async (seconds, crop) => {
    const { stderr } = await run(config.ffmpegPath, [
      '-hide_banner', '-nostats', '-i', result.outputFile,
      '-vf', `trim=start=${seconds.toFixed(3)},crop=${crop},signalstats,` +
        'metadata=print:key=lavfi.signalstats.YAVG',
      '-frames:v', '1', '-f', 'null', '-',
    ])
    return Number(stderr.match(/YAVG=([0-9.]+)/)?.[1] ?? NaN)
  }

  const [before, during, after, besideIt] = await Promise.all([
    lumaOf(1.0, corner),
    lumaOf(3.0, corner),
    lumaOf(5.0, corner),
    lumaOf(3.0, elsewhere),
  ])

  check('avatar bubble is absent before the line', before < 60, `corner luma ${before.toFixed(1)}`)
  check('avatar bubble is on screen while the line plays', during > 100, `corner luma ${during.toFixed(1)}`)
  check('avatar bubble is gone after the line', after < 60, `corner luma ${after.toFixed(1)}`)
  check(
    'the rest of the picture is untouched by the bubble',
    Math.abs(besideIt - before) < 2,
    `${besideIt.toFixed(1)} vs ${before.toFixed(1)}`,
  )
  check('the render counts its bubbles', result.avatarCount === 1, `${result.avatarCount}`)

  // The corner is a choice, and the maths that places it has no picture to check it by.
  const [topLeftClip, topLeftOverlay] = avatarOverlayFilters(
    [{ file: clip, atMs: 4000, durationMs: 1500 }],
    {
      firstInput: 2,
      outputWidth: OUT_W,
      corner: 'top-left',
      size: AVATAR_SIZE,
      fps: 25,
      inLabel: 'picture',
      outLabel: 'vout',
    },
  )
  check(
    'a top-left bubble is placed against the top-left corner',
    topLeftOverlay.includes(`x=${margin}:y=${margin}`) && topLeftOverlay.endsWith('[vout]'),
    topLeftOverlay.slice(topLeftOverlay.indexOf('overlay=')),
  )
  check(
    'a bubble starts where its line starts and lasts as long',
    topLeftClip.includes('setpts=PTS+4.000/TB') && topLeftClip.includes('trim=0:1.500'),
    '4.0s for 1.5s',
  )

  /**
   * With an idle clip the bubble never goes away: the avatar is on screen between the
   * lines too, and the spoken clip takes its place while a line plays. The first
   * version had no idle layer, and on a real video the bubble appeared four times for
   * a couple of seconds each and was gone the rest of the time.
   */
  const idle = path.join(dir, 'idle.mp4')
  await run(config.ffmpegPath, [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', 'color=c=red:s=720x720:r=25:d=2',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', idle,
  ])
  const withIdle = await compose(config, {
    rawVideo: base,
    cues: [],
    outputDir: dir,
    music: null,
    musicGainDb: 0,
    subtitles: false,
    outputName: 'with-idle.mp4',
    outputWidth: OUT_W,
    outputHeight: OUT_H,
    avatarClips: [{ file: clip, atMs: 2000, durationMs: 2000 }],
    avatarIdle: idle,
  })

  const lumaIn = async (file, seconds, crop) => {
    const { stderr } = await run(config.ffmpegPath, [
      '-hide_banner', '-nostats', '-i', file,
      '-vf', `trim=start=${seconds.toFixed(3)},crop=${crop},signalstats,` +
        'metadata=print:key=lavfi.signalstats.YAVG',
      '-frames:v', '1', '-f', 'null', '-',
    ])
    return Number(stderr.match(/YAVG=([0-9.]+)/)?.[1] ?? NaN)
  }
  const [idleBefore, speakingNow, idleAfter] = await Promise.all([
    lumaIn(withIdle.outputFile, 1.0, corner),
    lumaIn(withIdle.outputFile, 3.0, corner),
    lumaIn(withIdle.outputFile, 5.0, corner),
  ])
  check(
    'the avatar is on screen before its first line',
    idleBefore > 60 && idleBefore < 150,
    `corner luma ${idleBefore.toFixed(1)}, background is 57`,
  )
  check(
    'the spoken clip takes the bubble over while the line plays',
    speakingNow > 170,
    `corner luma ${speakingNow.toFixed(1)}`,
  )
  check(
    'the avatar stays on screen after the line',
    idleAfter > 60 && idleAfter < 150,
    `corner luma ${idleAfter.toFixed(1)}`,
  )

  fs.rmSync(dir, { recursive: true, force: true })
}

/**
 * The opening, closing and chapter cards.
 *
 * The cards themselves come from HyperFrames, but what can go wrong is here: a card
 * joined so that it shortens the timeline and pulls every line of narration ahead of
 * its picture, a caption left at the recording's own time, a transparent card that
 * arrives opaque. So the composition is checked with plain coloured stand-ins - red
 * opening, blue closing, a half-transparent white chapter card - whose colours say
 * exactly which one is on screen. A real HyperFrames card is rendered as well where
 * the package is installed.
 */
async function motionCards(config) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-cards-'))
  const make = (file, args) =>
    run(config.ffmpegPath, ['-hide_banner', '-loglevel', 'error', '-y', ...args, file]).then(() => file)

  const base = await make(path.join(dir, 'base.mp4'), [
    '-f', 'lavfi', '-i', `color=c=0x303030:s=${OUT_W}x${OUT_H}:r=25:d=5`,
    '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p',
  ])
  // Tagged BT.709, as HyperFrames writes its mp4s.
  const card = colour => [
    '-f', 'lavfi', '-i', `color=c=${colour}:s=1920x1080:r=25:d=2`,
    '-vf', 'scale=out_color_matrix=bt709:out_range=tv,format=yuv420p',
    '-c:v', 'libx264', '-preset', 'ultrafast',
    '-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709',
  ]
  const opening = await make(path.join(dir, 'opening.mp4'), card('red'))
  const closing = await make(path.join(dir, 'closing.mp4'), card('blue'))
  // VP9 with alpha, as the chapter cards are. The alpha is set on RGBA: `white@0.5` on
  // the colour source looks like it would do it and does not - its alpha came out 255.
  const chapter = await make(path.join(dir, 'chapter.webm'), [
    '-f', 'lavfi', '-i', 'color=c=white:s=1920x1080:r=25:d=1',
    '-vf', 'format=rgba,colorchannelmixer=aa=0.5,format=yuva420p',
    '-c:v', 'libvpx-vp9', '-pix_fmt', 'yuva420p', '-auto-alt-ref', '0',
  ])
  const speech = await speechStandIn(config, path.join(dir, 'line.m4a'), 1.5)

  const options = {
    rawVideo: base,
    cues: [{ atMs: 1000, text: 'One line of narration', audioFile: speech, durationMs: 1500, voiceId: 'e2e' }],
    outputDir: dir,
    music: null,
    musicGainDb: 0,
    subtitles: true,
    outputWidth: OUT_W,
    outputHeight: OUT_H,
    opening,
    closing,
    overlays: [{ file: chapter, atMs: 3000, durationMs: 1000 }],
  }
  const result = await compose(config, options)

  // Mean Y, U and V of the frame at a moment: red has V high, blue U high, grey both
  // at 128. Sampled with trim, for the reason given in avatarBubble.
  const colourAt = async (file, seconds) => {
    const { stderr } = await run(config.ffmpegPath, [
      '-hide_banner', '-nostats', '-i', file,
      '-vf', `trim=start=${seconds.toFixed(3)},signalstats,metadata=print`,
      '-frames:v', '1', '-f', 'null', '-',
    ])
    const read = key => Number(stderr.match(new RegExp(`signalstats\\.${key}=([0-9.]+)`))?.[1] ?? NaN)
    return { y: read('YAVG'), u: read('UAVG'), v: read('VAVG') }
  }
  const isGrey = c => Math.abs(c.u - 128) < 6 && Math.abs(c.v - 128) < 6
  const show = c => `Y${c.y.toFixed(0)} U${c.u.toFixed(0)} V${c.v.toFixed(0)}`

  const { stdout: frameCount } = await run(config.ffprobePath, [
    '-v', 'error', '-select_streams', 'v:0', '-count_frames',
    '-show_entries', 'stream=nb_read_frames', '-of', 'csv=p=0', result.outputFile,
  ])
  check(
    'opening + recording + closing, and not a frame less',
    Number(frameCount.trim()) === 225 && result.openingSec === 2 && result.closingSec === 2,
    `${frameCount.trim()} frames = 50 + 125 + 50`,
  )

  // The dissolves are 0.6 s: the opening holds to 2.0 s and has given way by 2.6 s,
  // the recording holds to 7.0 s and the closing has taken over by 7.6 s.
  const at = seconds => colourAt(result.outputFile, seconds)
  const [inOpening, lastOfOpening, midDissolve, recordingIn, inRecording, underCard, afterCard, lastOfRecording, closingIn, inClosing] =
    await Promise.all([at(1.0), at(1.96), at(2.3), at(2.6), at(2.9), at(5.5), at(6.5), at(6.96), at(7.6), at(8.0)])
  check('the video opens on the opening card', inOpening.v > 200, show(inOpening))
  check(
    'the opening dissolves into the recording, from 2.0 s to 2.6 s',
    lastOfOpening.v > 235 && midDissolve.v > 140 && midDissolve.v < 215 && isGrey(recordingIn),
    `${show(lastOfOpening)} / ${show(midDissolve)} / ${show(recordingIn)}`,
  )
  check('the recording follows the opening', isGrey(inRecording) && Math.abs(inRecording.y - 57) < 5, show(inRecording))
  check(
    'the recording dissolves into the closing, from 7.0 s to 7.6 s',
    isGrey(lastOfRecording) && closingIn.u > 235,
    `${show(lastOfRecording)} / ${show(closingIn)}`,
  )
  check(
    'a chapter card lies over the picture at its moment, and lets it show through',
    isGrey(underCard) && underCard.y > 120 && underCard.y < 180,
    `${show(underCard)} - half white over grey`,
  )
  check('the chapter card is gone after its length', Math.abs(afterCard.y - 57) < 5, show(afterCard))
  check('the video ends on the closing card', inClosing.u > 200, show(inClosing))

  // Sound and captions move with the opening; the recording's own clock does not.
  const ass = fs.readFileSync(path.join(dir, 'captions.ass'), 'utf8')
  check(
    'a caption lands at its line plus the opening',
    /Dialogue: 0,0:00:03\.00,/.test(ass),
    ass.match(/Dialogue: 0,([^,]+),/)?.[1] ?? 'no caption',
  )
  const [openingSound, lineSound] = await Promise.all([
    loudnessOf(config, result.outputFile, 0.2, 1.6),
    loudnessOf(config, result.outputFile, 3.0, 1.5),
  ])
  check(
    'the narration is heard after the opening, not under it',
    lineSound > -20 && !(openingSound > -50),
    `line ${lineSound.toFixed(1)} LUFS, opening ${Number.isFinite(openingSound) ? openingSound.toFixed(1) : 'silent'}`,
  )
  const ended = await verifyOutput(config, result.outputFile)
  check('picture and sound end together with the cards', ended.ok, ended.problems.join('; '))

  // `transitions` is about the cuts inside the recording. The cards still dissolve, and
  // the timing is the same.
  const cut = await compose(config, { ...options, transitions: false, outputName: 'cut.mp4', subtitles: false })
  const [cutRecording, cutClosing] = await Promise.all([colourAt(cut.outputFile, 2.9), colourAt(cut.outputFile, 8.0)])
  check(
    'with transitions off the cards keep their places',
    Math.abs(cut.durationSec - 9.0) < 0.05 && isGrey(cutRecording) && cutClosing.u > 200,
    `${cut.durationSec.toFixed(2)}s, ${show(cutRecording)}, ${show(cutClosing)}`,
  )

  check(
    'card text is escaped and an empty slot vanishes',
    fillTemplate('<b>{{title}}</b>{{missing}}', { title: ' A & <B> ' }) === '<b>A &amp; &lt;B&gt;</b>',
    fillTemplate('<b>{{title}}</b>{{missing}}', { title: ' A & <B> ' }),
  )

  const availability = motionAvailability()
  if (availability.ok) {
    const rendered = await renderMotion(config, {
      template: 'chapter',
      durationSec: 1.6,
      transparent: true,
      values: { counter: '01 / 02', title: 'An e2e chapter', description: 'Rendered by HyperFrames.' },
      outFile: path.join(dir, 'hf-chapter'),
    })
    const info = await probeVideo(config.ffprobePath, rendered)
    // The alpha plane, read as a picture: clear at the start, the veil at full cover.
    const alphaAt = async seconds => {
      const { stderr } = await run(config.ffmpegPath, [
        '-hide_banner', '-nostats',
        ...(rendered.endsWith('.webm') ? ['-c:v', 'libvpx-vp9'] : []),
        '-i', rendered,
        '-vf', `trim=start=${seconds.toFixed(3)},format=yuva420p,alphaextract,signalstats,` +
          'metadata=print:key=lavfi.signalstats.YAVG',
        '-frames:v', '1', '-f', 'null', '-',
      ])
      return Number(stderr.match(/YAVG=([0-9.]+)/)?.[1] ?? NaN)
    }
    const [clear, covered] = await Promise.all([alphaAt(0), alphaAt(0.8)])
    check(
      'HyperFrames renders a chapter card of the asked length',
      info.width === 1920 && Math.abs(info.durationSec - 1.6) < 0.1,
      `${path.basename(rendered)}, ${info.width}x${info.height}, ${info.durationSec.toFixed(2)}s`,
    )
    check(
      'the rendered card is transparent until its veil comes in',
      clear < 30 && covered > 190,
      `alpha ${clear.toFixed(0)} at the start, ${covered.toFixed(0)} at 0.8s`,
    )
  } else {
    process.stdout.write(`  (no HyperFrames render checked: ${availability.reason})\n`)
  }

  fs.rmSync(dir, { recursive: true, force: true })
}

/**
 * The stage: the recording set into a window on the Stardawn ground.
 *
 * Checked on a flat grey stand-in capture at the window's size, so every pixel says
 * which layer it came from: grey is the recording, navy the ground. The bar is checked
 * by its fingerprint - identical while one site is on screen, different once the next
 * one is - because its text is too small for a colour average to tell apart.
 */
async function stageCheck(config) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-stage-'))
  const layout = stageLayout(OUT_W, OUT_H)
  const { content } = layout
  // Centred to within a pixel: positions are kept even, so the chroma of a 4:2:0
  // picture lines up with the stage's.
  check(
    'the window is five sixths of the frame, and centred',
    content.width === 1066 && content.height === 600 && Math.abs(content.x - (OUT_W - 1066) / 2) <= 1,
    `${content.width}x${content.height} at ${content.x},${content.y}`,
  )

  const base = path.join(dir, 'base.mp4')
  await run(config.ffmpegPath, [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', `color=c=0x303030:s=${content.width}x${content.height}:r=25:d=4`,
    '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', base,
  ])
  const stage = await stageComposition(config, {
    width: OUT_W,
    height: OUT_H,
    locations: [
      { atMs: 0, host: 'first.example' },
      { atMs: 2000, host: 'second.example' },
    ],
  })
  const result = await compose(config, {
    rawVideo: base,
    cues: [],
    outputDir: dir,
    music: null,
    musicGainDb: 0,
    subtitles: false,
    outputWidth: OUT_W,
    outputHeight: OUT_H,
    captureWidth: content.width,
    captureHeight: content.height,
    stage,
  })

  const statsAt = async (seconds, crop) => {
    const { stderr } = await run(config.ffmpegPath, [
      '-hide_banner', '-nostats', '-i', result.outputFile,
      '-vf', `trim=start=${seconds.toFixed(3)},crop=${crop},signalstats,metadata=print`,
      '-frames:v', '1', '-f', 'null', '-',
    ])
    const read = key => Number(stderr.match(new RegExp(`signalstats\\.${key}=([0-9.]+)`))?.[1] ?? NaN)
    return { y: read('YAVG'), u: read('UAVG'), v: read('VAVG') }
  }
  const fingerprint = async (seconds, crop) => {
    const { stdout } = await run(config.ffmpegPath, [
      '-hide_banner', '-loglevel', 'error', '-i', result.outputFile,
      '-vf', `trim=start=${seconds.toFixed(3)},crop=${crop}`, '-frames:v', '1', '-f', 'md5', '-',
    ])
    return stdout.trim()
  }

  const inside = `40:40:${content.x + content.width / 2 - 20}:${content.y + content.height / 2 - 20}`
  // Bottom left: the two soft lights sit top left and bottom right.
  const ground = `24:24:8:${OUT_H - 32}`
  const corner = `3:3:${content.x}:${content.y + content.height - 3}`
  const bar = `${content.width}:${layout.bar}:${content.x}:${layout.window.y}`
  const [windowStats, groundStats, cornerStats] = await Promise.all([
    statsAt(1.0, inside),
    statsAt(1.0, ground),
    statsAt(1.0, corner),
  ])
  check('the recording fills the window', Math.abs(windowStats.y - 57) < 3, `Y ${windowStats.y.toFixed(1)}`)
  check(
    'the ground around it is the Stardawn navy',
    groundStats.y < 45 && groundStats.u > 128,
    `Y ${groundStats.y.toFixed(1)} U ${groundStats.u.toFixed(1)}`,
  )
  check(
    "the window's corner is rounded off, not square",
    Math.abs(cornerStats.y - 57) > 8,
    `corner Y ${cornerStats.y.toFixed(1)} against the recording's 57`,
  )

  const [first, stillFirst, second] = await Promise.all([
    fingerprint(0.5, bar),
    fingerprint(1.5, bar),
    fingerprint(3.0, bar),
  ])
  check(
    'the bar holds while one site is on screen and changes with the next',
    first === stillFirst && first !== second,
    `${first.slice(-6)} ${stillFirst.slice(-6)} ${second.slice(-6)}`,
  )
  check('the stage costs the video no time', Math.abs(result.durationSec - 4) < 0.05, `${result.durationSec.toFixed(2)}s`)

  check(
    'the bar names the host and nothing after it',
    hostOf('https://www.example.com/oauth/callback?code=secret#x') === 'example.com' && hostOf('about:blank') === null,
    hostOf('https://www.example.com/oauth/callback?code=secret#x'),
  )
  check(
    'a shortcut is written as keycaps',
    JSON.stringify(keycaps('Control+Shift+k')) === '["Ctrl","Shift","K"]' &&
      JSON.stringify(keycaps('Control++')) === '["Ctrl","+"]' &&
      JSON.stringify(keycaps('Enter')) === '["Enter ↵"]',
    `${keycaps('Control+Shift+k').join(' ')} | ${keycaps('Control++').join(' ')} | ${keycaps('Enter').join(' ')}`,
  )

  fs.rmSync(dir, { recursive: true, force: true })
}

/** A stand-in for Instagram's inbox, served at instagram.com so its schema entry applies. */
function avatarUrl(colour, initials) {
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="48" height="48"><circle cx="24" cy="24" r="24" fill="${colour}"/>` +
    `<text x="24" y="31" font-family="Segoe UI,sans-serif" font-size="19" font-weight="700" fill="#fff" text-anchor="middle">${initials}</text></svg>`
  return `data:image/svg+xml,${encodeURIComponent(svg)}`
}

const INBOX_PAGE = `<!doctype html><meta charset="utf-8"><title>Instagram - Direct</title>
<style>
 body{font:15px/1.4 "Segoe UI",system-ui,sans-serif;margin:0;display:flex;color:#111;background:#fff}
 nav{width:200px;padding:24px;border-right:1px solid #ddd;display:flex;flex-direction:column;gap:18px}
 nav a{color:#111;text-decoration:none;font-weight:600;font-size:16px}
 .inbox{width:430px;border-right:1px solid #ddd}
 .inbox a{display:flex;gap:12px;align-items:center;padding:12px 20px;color:#111;text-decoration:none}
 .inbox img{width:48px;height:48px;border-radius:50%}
 .inbox b{display:block}
 .thread{flex:1;padding:20px}
 [role=row]{margin:10px 0;padding:10px 14px;border-radius:18px;background:#efefef;max-width:440px}
 p{margin:14px 0}
 input{font:15px "Segoe UI",sans-serif;padding:8px;width:280px;display:block;margin:8px 0}
 #notify{position:fixed;left:40%;top:30%;padding:24px;background:#fff;box-shadow:0 8px 40px #0006;border-radius:12px}
</style>
<nav><a href="/">Home</a><a href="/explore/">Explore</a><a id="navmsg" href="/direct/inbox/">Messages</a></nav>
<section class="inbox">
 <a id="t1" href="/direct/t/111/"><img alt="Maria Schneider's profile picture" src="${avatarUrl('#e91e63', 'MS')}"><span><b>Maria Schneider</b>Are we still on for Friday?</span></a>
 <a id="t2" href="/direct/t/222/"><img alt="InStar Support's profile picture" src="${avatarUrl('#0a7cff', 'IS')}"><span><b class="name">InStar Support</b>Your account is connected.</span></a>
 <a id="t3" href="/direct/t/333/"><img alt="Tom Becker's profile picture" src="${avatarUrl('#ff9800', 'TB')}"><span><b>Tom Becker</b>Sent you the invoice yesterday.</span></a>
</section>
<section class="thread">
 <div role="grid" aria-label="Messages in conversation with InStar Support">
  <div role="row" id="m1">Hi! Reach me at max.mustermann@example.com</div>
  <div role="row" id="m2">Your Instagram account is connected.</div>
 </div>
 <p id="contact">Call +49 30 12345678 or write to max.mustermann@example.com. Key: sk-proj-abcdefghijklmnopqrstuvwx</p>
 <p id="clean">Version 2.14.3, released 2026-09-25, 100 000 followers.</p>
 <input id="mail" type="email" value="someone@example.com">
 <input id="plain" type="text" value="Just a label">
 <input id="note" type="text" placeholder="Note">
</section>
<div role="dialog" id="notify"><h2>Turn on Notifications</h2><button id="notnow">Not Now</button> <button>Turn On</button></div>
<div id="credential_picker_container">Sign in as Jane Doe</div>
<script>
 document.getElementById('notnow').onclick = () => { window.__dismissed = true; document.getElementById('notify').remove() }
</script>`

/** How much fine detail a region holds: the share of it that is an edge. Blur removes edges. */
async function edgeDensity(config, input, box, inputArgs = []) {
  const crop = [box.width, box.height, box.x, box.y].map(v => Math.max(0, Math.round(v))).join(':')
  const { stderr } = await run(config.ffmpegPath, [
    '-hide_banner', '-nostats', ...inputArgs, '-i', input,
    '-vf', `crop=${crop},format=gray,edgedetect=low=0.08:high=0.2,signalstats,metadata=print`,
    '-frames:v', '1', '-f', 'null', '-',
  ])
  return Number(stderr.match(/signalstats\.YAVG=([0-9.]+)/)?.[1] ?? NaN)
}

/**
 * Private data kept out of the picture.
 *
 * The detectors first, on their own, including what they must leave alone - covering
 * every version number and date would make a tutorial unreadable. Then the whole layer
 * in a real session, on a stand-in for Instagram's inbox served at instagram.com: other
 * people's conversations greyed out, the one the tutorial touches kept, personal data
 * covered before it is painted - and all of it already in the capture file.
 */
async function privacyCheck(config) {
  process.stdout.write('\nPrivacy...\n')
  const detector = createDetector()
  const found = t => detector.find(t).map(d => `${d.kind}:${t.slice(d.index, d.index + d.length)}`)

  const mustFind = [
    ['write to max.mustermann@example.com today', 'email:max.mustermann@example.com'],
    ['call +49 30 12345678 now', 'phone:+49 30 12345678'],
    ['or on 030 12345678', 'phone:030 12345678'],
    ['IBAN DE89 3704 0044 0532 0130 00', 'iban:DE89 3704 0044 0532 0130 00'],
    ['card 4111 1111 1111 1111 expires', 'card:4111 1111 1111 1111'],
    ['key sk-proj-abcdefghijklmnopqrstuvwx', 'secret:sk-proj-abcdefghijklmnopqrstuvwx'],
    ['token ghp_abcdefghijklmnopqrstuvwxyz0123456789', 'secret:ghp_abcdefghijklmnopqrstuvwxyz0123456789'],
    ['AWS AKIAIOSFODNN7EXAMPLE here', 'secret:AKIAIOSFODNN7EXAMPLE'],
  ]
  const missed = mustFind.filter(([t, want]) => !found(t).includes(want))
  check(
    'email addresses, phone numbers, IBANs, cards and keys are found',
    missed.length === 0,
    missed.length ? `missed: ${missed.map(m => m[1]).join(', ')}` : `${mustFind.length} kinds of example`,
  )
  const mustNot = [
    'Version 2.14.3',
    'released 2026-09-25',
    'Price 1,299.00 EUR',
    'commit 09b6fae1c3',
    'follow @jim_presting',
    '100 000 followers',
    'IBAN DE12 3456 7890 1234 5678 90',
    'card 4111 1111 1111 1112',
    'order 1234567890124',
    'call 112',
    'ISSN 0413-4360',
  ]
  const falseAlarms = mustNot.filter(t => found(t).length > 0)
  check(
    'versions, dates, prices, handles and numbers failing their check digits are left alone',
    falseAlarms.length === 0,
    falseAlarms.length ? `covered: ${falseAlarms.map(t => `${t} -> ${found(t)}`).join('; ')}` : `${mustNot.length} examples`,
  )

  const session = await RecordingSession.start(config, {
    title: 'E2E Privacy',
    profile: 'e2e-privacy',
    fresh: true,
    width: OUT_W,
    height: OUT_H,
    headless: true,
    deviceScaleFactor: 1,
    voiceId: config.defaultVoiceId,
    modelId: config.defaultModelId,
    music: null,
    musicGainDb: 0,
    showActions: false,
    quality: 90,
    emphasis: false,
    autoZoom: false,
    privacy: { veil: true, cookies: true, hideText: ['Tom Becker'] },
  })
  const page = session.page
  try {
    await page.context().route('https://www.instagram.com/**', route =>
      route.fulfill({ contentType: 'text/html; charset=utf-8', body: INBOX_PAGE }),
    )
    await page.goto('https://www.instagram.com/direct/inbox/', { waitUntil: 'domcontentloaded' })
    await page.waitForTimeout(900)

    const blurred = id => page.evaluate(i => getComputedStyle(document.getElementById(i)).filter, id)
    const [t1, t2, t3, nav, m1] = await Promise.all(['t1', 't2', 't3', 'navmsg', 'm1'].map(blurred))
    check(
      "other people's conversations are greyed out on first paint, the platform's own links are not",
      /blur/.test(t1) && /blur/.test(t2) && /blur/.test(t3) && nav === 'none',
      `thread ${t1.split(' ')[0]}, navigation ${nav}`,
    )
    check('messages in a conversation are greyed out by their screen-reader label', /blur/.test(m1), m1.split(' ')[0])

    const covered = () =>
      page.evaluate(() => [...(CSS.highlights.get('tc-private') ?? [])].filter(r => !r.collapsed).map(r => r.toString()))
    const bars = await covered()
    const wanted = ['max.mustermann@example.com', '+49 30 12345678', 'sk-proj-abcdefghijklmnopqrstuvwx', 'Tom Becker']
    check(
      'personal data in text is covered with a bar, and so is a word the tutorial named',
      wanted.every(w => bars.includes(w)) && !bars.some(b => /2\.14\.3|2026|100 000/.test(b)),
      `${bars.length} bars: ${[...new Set(bars)].join(' | ')}`,
    )

    const security = id => page.evaluate(i => getComputedStyle(document.getElementById(i)).webkitTextSecurity, id)
    await page.locator('#note').pressSequentially('someone.else@example.org', { delay: 5 })
    const [mail, plain, note] = await Promise.all(['mail', 'plain', 'note'].map(security))
    check(
      'an email field and an address typed into a plain field show dots, other fields do not',
      mail === 'disc' && note === 'disc' && plain === 'none',
      `email ${mail}, typed ${note}, plain ${plain}`,
    )

    const prompt = await page.evaluate(() => ({ dismissed: Boolean(window.__dismissed), gone: !document.getElementById('notify') }))
    const oneTap = await page.evaluate(() => getComputedStyle(document.getElementById('credential_picker_container')).display)
    check(
      'a "Turn on notifications" prompt is answered "Not now", the one-tap account chooser hidden',
      prompt.dismissed && prompt.gone && oneTap === 'none',
      `prompt ${prompt.gone ? 'gone' : 'still there'}, one-tap ${oneTap}`,
    )

    // Arriving while the page is open: judged in the next animation frame, which runs
    // before the browser paints - so it is covered in the first frame it appears in.
    const late = await page.evaluate(() => new Promise(resolve => {
      const row = document.createElement('a')
      row.href = '/direct/t/444/'
      row.id = 't4'
      row.textContent = 'Late Arrival - write to late.person@example.net'
      document.querySelector('.inbox').append(row)
      requestAnimationFrame(() => resolve({
        filter: getComputedStyle(row).filter,
        covered: [...CSS.highlights.get('tc-private')].some(r => r.toString() === 'late.person@example.net'),
      }))
    }))
    check(
      'a conversation arriving later is greyed out and covered before its first frame',
      /blur/.test(late.filter) && late.covered,
      `${late.filter.split(' ')[0]}, address ${late.covered ? 'covered' : 'visible'}`,
    )

    // What the tutorial touches keeps its whole unit: the name inside the conversation
    // brings back the conversation, picture and all.
    await session.privacy.keepAuto(page.locator('#t2 .name'))
    await session.updatePrivacy({ keepCss: ['#m2'] })
    await page.waitForTimeout(700)
    const [t1b, t2b, t3b, m1b, m2b] = await Promise.all(['t1', 't2', 't3', 'm1', 'm2'].map(blurred))
    const avatarKept = await page.evaluate(() => getComputedStyle(document.querySelector('#t2 img')).filter)
    check(
      'the conversation the tutorial acts on comes out whole, the others stay grey',
      t2b === 'none' && avatarKept === 'none' && /blur/.test(t1b) && /blur/.test(t3b),
      `kept ${t2b}, its picture ${avatarKept}, others ${t1b.split(' ')[0]}`,
    )
    check('a message kept by the tutorial is shown, the one beside it is not', m2b === 'none' && /blur/.test(m1b), `${m2b} / ${m1b.split(' ')[0]}`)

    // tutorial_type with sensitive: true greys the field out as well - and it stays
    // grey when the tutorial changes what is kept afterwards.
    await session.updatePrivacy({ hide: [{ label: '#plain', locate: p => p.locator('#plain') }] })
    await session.updatePrivacy({ keepCss: ['#m1'] })
    const sensitiveField = await blurred('plain')
    check('a field typed into as sensitive is greyed out, and stays so', /blur/.test(sensitiveField), sensitiveField.split(' ')[0])

    const report = describePrivacy(await session.privacy.report(page))
    check('the tool reports what it keeps out of the picture', /Instagram/.test(report) && /Kept visible/.test(report), report.split('\n')[0])

    const consent = await page.evaluate(() => Boolean(window.autoconsentStandalone))
    check('the cookie-banner handler is running in the page', consent)

    // In the picture, not only in the styles: fine detail survives in the kept
    // conversation and is gone from the greyed-out ones.
    const shot = path.join(session.outputDir, 'privacy.png')
    await page.screenshot({ path: shot })
    const boxes = await Promise.all(['#t1', '#t2'].map(s => page.locator(s).boundingBox()))
    const [greyEdges, keptEdges] = await Promise.all(boxes.map(b => edgeDensity(config, shot, b)))
    check(
      'in the picture, a greyed-out conversation has lost its detail and the kept one has not',
      keptEdges > 8 * Math.max(greyEdges, 0.05),
      `edges ${greyEdges.toFixed(2)} against ${keptEdges.toFixed(2)}`,
    )

    // Off camera: the clock stands still until the camera is back on.
    const before = session.videoTimeMs
    session.setLive(false)
    await page.waitForTimeout(1200)
    session.setLive(true)
    const held = session.videoTimeMs - before
    check('time off camera is left out of the video', held < 150, `${held}ms of 1200 counted`)

    await page.waitForTimeout(1200)
    const { segments } = await session.stopRecording()
    const capture = segments[0]?.file
    const [greyCapture, keptCapture] = capture
      ? await Promise.all(boxes.map(b => edgeDensity(config, capture, b, ['-sseof', '-0.6'])))
      : [NaN, NaN]
    check(
      'the capture file itself holds the greyed-out picture',
      keptCapture > 8 * Math.max(greyCapture, 0.05),
      `edges ${greyCapture.toFixed(2)} against ${keptCapture.toFixed(2)}`,
    )
  } finally {
    if (!session.isFinished) await session.cancel().catch(() => {})
    // E2E_KEEP=1 leaves the screenshot and the capture behind, to be looked at.
    if (!process.env.E2E_KEEP) fs.rmSync(session.outputDir, { recursive: true, force: true })
  }
}

/**
 * Decorations on a page that enforces Trusted Types.
 *
 * Playwright puts every overlay into the page with innerHTML, which such a page
 * blocks - YouTube and Google's other apps do. The rings, cards and keycaps were
 * simply missing from every frame there, and nothing noticed, because nothing looked
 * at the pixels of a real overlay. This does, on a local page sending the same policy.
 */
async function overlaysUnderTrustedTypes(config) {
  process.stdout.write('\nDecorations under Trusted Types...\n')
  const server = http.createServer((req, res) => {
    res.writeHead(200, {
      'content-type': 'text/html; charset=utf-8',
      'content-security-policy': "require-trusted-types-for 'script'",
    })
    res.end('<!doctype html><title>Strict</title><body style="margin:0;background:#fff"><h1>Strict page</h1></body>')
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const url = `http://127.0.0.1:${server.address().port}/`
  const session = await RecordingSession.start(config, {
    title: 'E2E Trusted Types',
    profile: 'e2e-trusted-types',
    fresh: true,
    width: 800,
    height: 600,
    headless: true,
    deviceScaleFactor: 1,
    voiceId: config.defaultVoiceId,
    modelId: config.defaultModelId,
    music: null,
    musicGainDb: 0,
    showActions: true,
    quality: 90,
    emphasis: true,
    autoZoom: false,
  }, url)
  try {
    const blocked = await session.page.evaluate(() => {
      try {
        document.createElement('div').innerHTML = '<b>x</b>'
        return false
      } catch {
        return true
      }
    })
    const at = session.videoTimeMs
    await instruct(session.page, { x: 560, y: 300, width: 120, height: 60 }, 'A card on a strict page.', { durationMs: 2500 })
    await session.page.waitForTimeout(1800)
    const { segments } = await session.stopRecording()
    // The card sits in the left margin, navy on a white page.
    const { stderr } = await run(config.ffmpegPath, [
      '-hide_banner', '-nostats', '-i', segments[0].file,
      '-vf', `trim=start=${((at + 1200) / 1000).toFixed(2)},crop=60:24:60:318,signalstats,metadata=print`,
      '-frames:v', '1', '-f', 'null', '-',
    ])
    const y = Number(stderr.match(/signalstats\.YAVG=([0-9.]+)/)?.[1] ?? NaN)
    // Without the recorder ignoring the policy, this comes out white (Y 235): the card
    // is blocked. Checked by switching bypassCSP off.
    check(
      'an instruction card is drawn on a page that enforces Trusted Types',
      y < 90,
      `card Y ${y.toFixed(1)}, the page's policy ${blocked ? 'still enforced in its own scripts' : 'set aside while recording'}`,
    )
  } finally {
    if (!session.isFinished) await session.cancel().catch(() => {})
    fs.rmSync(session.outputDir, { recursive: true, force: true })
    server.close()
  }
}

/**
 * What a bot check reads, and the two-factor codes typed into one.
 *
 * Both are things that silently stop working: a Playwright release that puts the
 * automation flag back, or an off-by-one in the counter that only shows up as a
 * rejected code. Neither is visible in a finished video, so they are asserted here.
 */
async function botAndTwoFactor(config) {
  const launched = await launchBrowser(config, {
    profile: 'e2e-bot-check',
    fresh: true,
    width: 800,
    height: 600,
    headless: true,
  })
  try {
    const seen = await launched.page.evaluate(() => ({
      userAgent: navigator.userAgent,
      webdriver: navigator.webdriver,
      hasChrome: Boolean(window.chrome),
      languages: navigator.languages.join(','),
    }))
    check(
      'the browser does not announce itself as headless',
      !/headless/i.test(seen.userAgent),
      seen.userAgent.replace(/^Mozilla\/5\.0 /, '').slice(0, 70),
    )
    check('navigator.webdriver is not set', !seen.webdriver, String(seen.webdriver))
    check('window.chrome is there, as in a browser a person drives', seen.hasChrome)
    check('the page reports real languages', seen.languages.length > 0, seen.languages)

    // The whole two-factor path, not just the arithmetic: read the secret from the
    // environment under the name a tool call would pass, and type the code into a
    // real field in a real browser.
    process.env.E2E_TOTP_SECRET = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ'
    await launched.page.goto(
      'data:text/html,<title>Two factor</title><input id="code" autocomplete="off">',
    )
    const code = await currentCode('E2E_TOTP_SECRET')
    await launched.page.locator('#code').pressSequentially(code, { delay: 10 })
    const inField = await launched.page.inputValue('#code')
    check(
      'a two-factor code is computed from the environment and typed into the field',
      inField === totp(process.env.E2E_TOTP_SECRET) && /^\d{6}$/.test(inField),
      `${inField.replace(/\d/g, '*')} (${inField.length} digits, ${secondsLeft()}s left on it)`,
    )
  } finally {
    await launched.context.close().catch(() => {})
    if (launched.disposableDir) fs.rmSync(launched.disposableDir, { recursive: true, force: true })
  }

  // RFC 6238's own test vectors: SHA-1, the ASCII secret "12345678901234567890".
  const secret = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ'
  const vectors = [
    [59_000, '94287082'],
    [1_111_111_109_000, '07081804'],
    [1_234_567_890_000, '89005924'],
    [2_000_000_000_000, '69279037'],
  ]
  const wrong = vectors.filter(
    ([atMs, expected]) => totp(secret, { atMs, digits: 8 }) !== expected,
  )
  check(
    'two-factor codes match the standard test vectors',
    wrong.length === 0,
    wrong.length ? `${wrong.length} of ${vectors.length} wrong` : `${vectors.length} vectors`,
  )
  check(
    'a six-digit code is six digits',
    /^\d{6}$/.test(totp(secret, { atMs: 1_234_567_890_000 })),
    totp(secret, { atMs: 1_234_567_890_000 }),
  )
}

/** The parts that run on their own: `node scripts/e2e.mjs privacy`. */
const SECTIONS = {
  'two-browsers': twoBrowsers,
  avatar: avatarBubble,
  motion: motionCards,
  stage: stageCheck,
  privacy: privacyCheck,
  'trusted-types': overlaysUnderTrustedTypes,
  bot: botAndTwoFactor,
}

async function main() {
  const config = loadConfig()
  const only = process.argv[2]
  if (only) {
    const section = SECTIONS[only]
    if (!section) throw new Error(`No section "${only}". Sections: ${Object.keys(SECTIONS).join(', ')}`)
    await section(config)
    const failed = results.filter(r => !r.ok)
    process.stdout.write(`\n${results.length - failed.length}/${results.length} checks passed\n`)
    process.exit(failed.length > 0 ? 1 : 0)
  }
  process.stdout.write('End-to-end pipeline check\n\n')

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tutorial-e2e-'))
  const pageFile = path.join(tmp, 'app.html')
  fs.writeFileSync(pageFile, TEST_PAGE)
  const pageUrl = pathToFileURL(pageFile).href

  process.stdout.write('Recording...\n')
  const session = await RecordingSession.start(config, {
    title: 'E2E Verify Account',
    profile: 'e2e-test',
    width: OUT_W,
    height: OUT_H,
    headless: true,
    deviceScaleFactor: CAPTURE_SCALE,
    voiceId: config.defaultVoiceId,
    modelId: config.defaultModelId,
    music: config.defaultMusic,
    musicGainDb: 0,
    showActions: true,
    quality: 90,
    emphasis: true,
    autoZoom: true,
  })

  const t0 = session.videoTimeMs
  check('recorder started with a time origin', t0 >= 0, `t0=${t0}ms`)

  await session.page.goto(pageUrl, { waitUntil: 'domcontentloaded' })
  await session.showChapter('Verifying your account', 'A short walkthrough', 1800)
  await session.page.waitForTimeout(1800)

  // Narration cue 1 - recorded, then genuinely waited out. Real audio, so the
  // ducking behaviour is exercised rather than assumed.
  // Four seconds and up, matching real narration. Below three, EBU R128 has too few
  // short-term windows to report a loudness range at all, and the levelling behaves
  // differently on a clip that claims to have none.
  const clip1 = await speechStandIn(config, path.join(session.outputDir, 'audio', 'e0.m4a'), 4.0)
  const cue1At = session.videoTimeMs
  session.addCue({
    atMs: cue1At,
    text: 'First, enter the email address you signed up with.',
    audioFile: clip1,
    durationMs: 4000,
    voiceId: config.defaultVoiceId,
  })
  await session.page.waitForTimeout(4000)

  // A field spanning most of the page is already readable; magnifying it would only
  // cut its ends off. Leaving it alone is the correct decision, so assert it.
  const email = await frameAndMark(
    session,
    '#email',
    'Use the address you signed up with - the code is sent there.',
  )
  check(
    'camera left a full-width field alone',
    email.scale === 1,
    `${email.scale.toFixed(2)}x on a ${Math.round(email.box.width)}px-wide field`,
  )
  await session.page.locator('#email').pressSequentially('jim@example.com', { delay: 60 })
  await session.page.waitForTimeout(600)

  const clip2 = await speechStandIn(config, path.join(session.outputDir, 'audio', 'e1.m4a'), 3.8)
  const cue2At = session.videoTimeMs
  session.addCue({
    atMs: cue2At,
    text: 'Then type the six digit code from your inbox.',
    audioFile: clip2,
    durationMs: 3800,
    voiceId: config.defaultVoiceId,
  })
  await session.page.waitForTimeout(3800)

  // The code field sits directly under the email field, so the camera should stay
  // where it is rather than pulling out and pushing straight back in.
  const zoomsBeforeCode = session.zoomEvents.length
  await frameAndMark(session, '#code', 'Copy the six digits from that email into this field.')
  check(
    'camera held its framing for a neighbouring field',
    session.zoomEvents.length === zoomsBeforeCode,
    `${session.zoomEvents.length} camera moves so far`,
  )
  await session.page.locator('#code').pressSequentially('482913', { delay: 90 })
  await session.page.waitForTimeout(600)

  const clip3 = await speechStandIn(config, path.join(session.outputDir, 'audio', 'e2.m4a'), 4.2)
  const cue3At = session.videoTimeMs
  session.addCue({
    atMs: cue3At,
    text: 'Finally, click verify account. That is all there is to it.',
    audioFile: clip3,
    durationMs: 4200,
    voiceId: config.defaultVoiceId,
  })
  const verify = await frameAndMark(
    session,
    '#verify',
    'Confirm to finish - the account is unlocked straight away.',
  )
  check('camera moved in on a small control', verify.scale > 1, `${verify.scale.toFixed(2)}x`)

  /**
   * The instruction card must never cover what it refers to.
   *
   * A caption pinned over the target was the previous design and it was worthless -
   * "Verify account" floating above a button reading Verify account, hiding the field
   * beside it. The card now goes in the opposite half of the frame, and this asserts
   * it for every target in this run rather than trusting the arithmetic.
   */
  const viewport = { width: OUT_W, height: OUT_H }
  const cardCases = [
    { name: 'email field', box: email.box },
    { name: 'verify button', box: verify.box },
  ]
  const clashes = cardCases.filter(c =>
    overlaps(instructionLayout(c.box, viewport, 'A sentence of roughly average length.').card, c.box),
  )
  check(
    'the instruction never covers what it points at',
    clashes.length === 0,
    clashes.length ? clashes.map(c => c.name).join(', ') : `${cardCases.length} targets checked`,
  )
  const zoomHoldAtMs = session.videoTimeMs
  await session.page.locator('#verify').click()
  await ripple(session.page, verify.box.x + verify.box.width / 2, verify.box.y + verify.box.height / 2)
  await session.page.waitForTimeout(4200)

  const framesBefore = session.frameCount
  const { segments, videoMs } = await session.stopRecording()
  session.writeTimeline(segments)
  const rawVideo = segments[0]?.file ?? null
  check('a recording without cuts is one segment', segments.length === 1, `${segments.length}`)

  // Only now: stopping the recording closes the camera move that is still open, and
  // a copy taken before that would carry a release time equal to its start.
  const zoomEvents = session.zoomEvents.map(e => ({ ...e }))
  check(
    'camera moves were recorded and closed',
    zoomEvents.length > 0 && zoomEvents.every(e => e.releaseMs > e.atMs),
    `${zoomEvents.length} move(s), last held ` +
      `${((zoomEvents[zoomEvents.length - 1].releaseMs - zoomEvents[zoomEvents.length - 1].atMs) / 1000).toFixed(1)}s`,
  )

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
  // The capture carries the extra pixels a camera move needs; the finished video is
  // the nominal size.
  // 1:1 with the viewport. A larger capture size does not add detail - it only pads
  // the canvas and leaves the picture in the corner.
  check(
    'raw capture matches the viewport exactly',
    rawInfo.width === OUT_W && rawInfo.height === OUT_H,
    `${rawInfo.width}x${rawInfo.height} for a ${OUT_W}x${OUT_H} video`,
  )
  check('raw video is constant 25 fps', Math.abs(rawInfo.frameRate - 25) < 0.5,
    `${rawInfo.frameRate.toFixed(1)} fps`)

  process.stdout.write('\nComposing...\n')
  const result = await compose(config, {
    rawVideo,
    cues: session.cues,
    zoomEvents,
    outputDir: session.outputDir,
    outputWidth: OUT_W,
    outputHeight: OUT_H,
    music: config.defaultMusic,
    musicGainDb: 0,
    subtitles: true,
  })

  check('mp4 was produced', fs.existsSync(result.outputFile), result.outputFile)
  check('mp4 has an audio track', result.hasAudio)

  const finalInfo = await probeVideo(config.ffprobePath, result.outputFile)
  check('final video is H.264', finalInfo.codec === 'h264', finalInfo.codec)
  check(
    'finished video is the requested size',
    finalInfo.width === OUT_W && finalInfo.height === OUT_H,
    `${finalInfo.width}x${finalInfo.height}`,
  )

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

  const overall = await loudnessOf(config, result.outputFile, 0, result.durationSec)
  check(
    'audio sits at a usable listening level',
    Number.isFinite(overall) && overall > -30,
    `${overall} LUFS`,
  )

  /**
   * The defect this guards against was reported as "I can't hear anything".
   *
   * Music was being normalised to -32 LUFS whenever narration existed anywhere in
   * the recording, including the stretches where nobody was speaking. The opening of
   * a finished video measured -31.9 LUFS - inaudible on a laptop. Nothing failed;
   * the file simply sounded empty.
   *
   * The opening here runs from the first frame to the first narration cue, so it is
   * music and nothing else. If it is quiet, the music is inaudible.
   */
  // Measured after the 2 s fade-in: the fade is intended, and averaging over it would
  // report the music as quieter than anyone actually hears it.
  const musicStartsAt = 2.4
  const openingSec = Math.max(1.5, cue1At / 1000 - 0.3 - musicStartsAt)
  const musicAlone = await loudnessOf(config, result.outputFile, musicStartsAt, openingSec)
  check(
    'music is audible when nobody is speaking',
    Number.isFinite(musicAlone) && musicAlone > -26,
    `${musicAlone} LUFS over ${openingSec.toFixed(1)}s before the first line`,
  )

  /**
   * The other half of the same complaint: the voice has to arrive at a speaking
   * level, whatever level the synthesiser handed over.
   *
   * A gain calculation that refused to exceed the peak ceiling could only lift these
   * clips by 2.8 dB of the 8.5 they needed, leaving narration at -21.7 LUFS against
   * music at -22.0 - a separation of 0.3 dB, which is no separation at all.
   */
  const underVoice = await loudnessOf(config, result.outputFile, cue1At / 1000 + 0.2, 2.2)
  check(
    'narration reaches a speaking level',
    Number.isFinite(underVoice) && underVoice > -19.5 && underVoice < -13,
    `${underVoice} LUFS`,
  )
  check(
    'the voice sits clearly above the music',
    Number.isFinite(underVoice) && underVoice - musicAlone > 3,
    `narration ${underVoice} LUFS vs music-only ${musicAlone} LUFS ` +
      `(+${(underVoice - musicAlone).toFixed(1)} dB)`,
  )

  /**
   * Prove the camera actually moved, rather than trusting that the filtergraph was
   * built. Rendering the same capture with no camera move at all gives a reference:
   * frames must match it before the first move and differ during one.
   */
  const flatFile = path.join(session.outputDir, 'no-zoom.mp4')
  await run(config.ffmpegPath, [
    '-hide_banner', '-loglevel', 'error', '-y', '-i', rawVideo,
    '-vf', `fps=25,scale=${OUT_W}:${OUT_H}:flags=lanczos`,
    '-an', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p',
    '-t', result.durationSec.toFixed(3), flatFile,
  ])

  const sampleAt = async (file, seconds) => {
    const out = path.join(session.outputDir, `frame-${file}-${seconds.toFixed(1)}.png`)
    // -ss after -i, deliberately. Seeking before the input snaps to the nearest
    // earlier keyframe, which for two files encoded at different presets silently
    // compares two entirely different moments - and reports them as identical.
    await run(config.ffmpegPath, [
      '-hide_banner', '-loglevel', 'error', '-y',
      '-i', file === 'zoom' ? result.outputFile : flatFile,
      '-ss', seconds.toFixed(3), '-frames:v', '1', out,
    ])
    return out
  }
  const differenceAt = async seconds => {
    const [a, b] = await Promise.all([sampleAt('zoom', seconds), sampleAt('flat', seconds)])
    const { stderr } = await run(config.ffmpegPath, [
      '-hide_banner', '-nostats', '-i', a, '-i', b, '-lavfi', 'psnr', '-f', 'null', '-',
    ])
    fs.rmSync(a, { force: true })
    fs.rmSync(b, { force: true })
    const m = stderr.match(/average:([\d.]+|inf)/)
    return m ? (m[1] === 'inf' ? 99 : Number(m[1])) : NaN
  }

  const firstMove = zoomEvents[0]
  const beforeAnyMove = await differenceAt(Math.max(0.2, firstMove.atMs / 1000 - 1.0))
  const duringMove = await differenceAt(zoomHoldAtMs / 1000 - 0.4)
  check(
    'picture is untouched before the camera moves',
    beforeAnyMove > 38,
    `${beforeAnyMove.toFixed(1)} dB against a no-zoom render`,
  )
  check(
    'picture is genuinely magnified while the camera is in',
    Number.isFinite(duringMove) && duringMove < 30,
    `${duringMove.toFixed(1)} dB against a no-zoom render`,
  )
  fs.rmSync(flatFile, { force: true })

  const srt = path.join(session.outputDir, 'captions.srt')
  check('subtitles were written', fs.existsSync(srt),
    fs.existsSync(srt) ? `${fs.readFileSync(srt, 'utf8').split('\n\n').length} entries` : '')

  /**
   * Burned-in captions are laid out in the video's own pixels, and they keep out of
   * the avatar's corner. Styling the SRT instead put the margins in ASS's default
   * 384-wide script space, where "keep 442 px clear" left less than a word of room
   * and the caption ran up the side of the frame.
   */
  const ass = buildAss(
    [{ atMs: 1000, durationMs: 2000, text: 'On the Channels page I click Connect with Instagram.', audioFile: null, voiceId: '' }],
    { width: 1920, height: 1080, reserve: { left: 0, right: 442 } },
  )
  check(
    'captions are laid out in the video\'s own pixels, clear of the avatar',
    ass.includes('PlayResX: 1920') && /MarginR|,96,442,/.test(ass) && ass.includes('Dialogue: 0,0:00:01.00'),
    ass.split('\n').find(l => l.startsWith('Style:'))?.slice(0, 60) ?? 'no style line',
  )

  /**
   * Word-by-word captions. Timings measured on a real InStar line by ElevenLabs'
   * forced alignment: the highlight has to start with the voice (120 ms in), move
   * from word to word, last exactly as long as the speech, and wrap like a plain
   * caption.
   */
  const aligned = [
    { text: 'This', startMs: 120, endMs: 220 },
    { text: 'is', startMs: 280, endMs: 400 },
    { text: 'InStar', startMs: 480, endMs: 840 },
    { text: 'by', startMs: 900, endMs: 1060 },
    { text: 'Stardawn', startMs: 1100, endMs: 1460 },
    { text: 'AI.', startMs: 1520, endMs: 1860 },
  ]
  const karaoke = karaokeText(aligned)
  const totalCs = [...karaoke.matchAll(/\\k(\d+)/g)].reduce((sum, m) => sum + Number(m[1]), 0)
  check(
    'word captions light up with the voice, word by word, for as long as it speaks',
    karaoke.startsWith('{\\k12}{\\k16}This') && totalCs === 186 && !karaoke.includes('\\N'),
    karaoke,
  )
  const long = karaokeText(
    estimateTimings('Instagram asks me to log in to the business account before anything else', 4000),
  )
  check('a long captioned line breaks in two', (long.match(/\\N/g) ?? []).length === 1, long.slice(0, 70))

  const guessed = estimateTimings('On the Channels page I click Connect with Instagram.', 2638)
  check(
    'without an alignment, word timings are estimated in order and inside the line',
    guessed.length === 9 &&
      guessed.every((w, i) => i === 0 || w.startMs >= (guessed[i - 1]?.endMs ?? 0) - 1) &&
      (guessed.at(-1)?.endMs ?? 0) <= 2638,
    `${guessed.length} words, last ends at ${guessed.at(-1)?.endMs}ms of 2638`,
  )

  /**
   * The final check must notice a picture that stops while the sound goes on. That
   * is how the first dissolve build failed: the video froze at the first cut, the
   * file still reported its full length, and nothing downstream objected.
   */
  const brokenDir = fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-broken-'))
  const broken = path.join(brokenDir, 'broken.mp4')
  await run(config.ffmpegPath, [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', 'testsrc2=s=320x180:r=25:d=2',
    '-f', 'lavfi', '-i', 'sine=f=440:d=5',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', broken,
  ])
  const brokenCheck = await verifyOutput(config, broken)
  check(
    'a video whose picture stops before its sound is reported, not delivered as fine',
    !brokenCheck.ok && brokenCheck.problems.some(p => p.includes('picture stops')),
    brokenCheck.problems.join('; ') || 'reported nothing',
  )
  fs.rmSync(brokenDir, { recursive: true, force: true })

  // A short line has to reach speaking level too. One-pass loudnorm needs three seconds
  // to settle, and real lines of 1.4 to 2.9 s came out 4 to 6 dB under target.
  const shortClip = await speechStandIn(config, path.join(tmp, 'short.m4a'), 1.4)
  const { stderr: shortLevels } = await run(config.ffmpegPath, [
    '-hide_banner', '-nostats', '-i', shortClip,
    '-af', `${narrationChain(1.4)},ebur128`, '-f', 'null', '-',
  ])
  const shortLufs = Number(
    shortLevels.match(/Integrated loudness:\s*[\r\n]+\s*I:\s*(-?[\d.]+)\s*LUFS/)?.[1] ?? NaN,
  )
  check(
    'a 1.4-second line still reaches a speaking level',
    Number.isFinite(shortLufs) && shortLufs > -19.5 && shortLufs < -13,
    `${shortLufs} LUFS`,
  )

  // The brief for composed music: the video's length, a timed structure, and no voice.
  const brief = musicPrompt(95, 'soft felt piano')
  check(
    'a composed-music brief names the length, the structure and no vocals',
    brief.includes('1:35') && brief.includes('[0:00 -') && /no vocals/i.test(brief),
    brief.split('\n')[0],
  )

  await twoBrowsers(config)
  await avatarBubble(config)
  await motionCards(config)
  await stageCheck(config)
  await privacyCheck(config)
  await overlaysUnderTrustedTypes(config)
  await botAndTwoFactor(config)

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
