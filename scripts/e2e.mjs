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
import { compose, narrationChain, verifyOutput } from '../dist/lib/compose.js'
import { spotlight, ripple, instruct, instructionLayout } from '../dist/lib/emphasis.js'
import { probeVideo, run } from '../dist/lib/ffmpeg.js'
import { musicPrompt } from '../dist/lib/music-gen.js'

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
  const looks = { light: y => y > 200, dark: y => y < 60, grey: y => y > 100 && y < 160 }
  const moments = [
    ['business before the first cut', switchAt - 200, 'light'],
    ['customer right after it', switchAt + 200, 'dark'],
    ['customer just before the wait', cutAt - 200, 'dark'],
    ['customer right after the wait', cutAt + 200, 'grey'],
    ['customer before switching back', backAt - 200, 'grey'],
    ['business right after', backAt + 200, 'light'],
  ]
  const wrong = []
  for (const [label, ms, want] of moments) {
    const y = await lumaAt(ms / 1000)
    if (!looks[want](y)) wrong.push(`${label}: luma ${y.toFixed(0)}, expected ${want}`)
  }
  check(
    'each cut lands where the clock says it does',
    wrong.length === 0,
    wrong.length ? wrong.join('; ') : `${moments.length} moments checked, 0.2s either side`,
  )
}

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
