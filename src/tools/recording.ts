/**
 * Tools that start, narrate and finish a recording.
 */

import fs from 'node:fs'
import path from 'node:path'
import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { pathToFileURL } from 'node:url'
import type { Config } from '../lib/env.js'
import { RecordingSession, getSession, requireSession, setSession } from '../lib/session.js'
import { synthesise, estimateSpokenMs, listVoices } from '../lib/tts.js'
import { compose, verifyOutput } from '../lib/compose.js'
import { log } from '../lib/logger.js'

const PRESETS = {
  '1080p': { width: 1920, height: 1080, deviceScaleFactor: 1 },
  '720p': { width: 1280, height: 720, deviceScaleFactor: 2 },
  '1440p': { width: 2560, height: 1440, deviceScaleFactor: 1 },
} as const

function text(body: string) {
  return { content: [{ type: 'text' as const, text: body }] }
}

function failure(body: string) {
  return { content: [{ type: 'text' as const, text: body }], isError: true }
}

export function registerRecordingTools(server: McpServer, config: Config): void {
  server.registerTool(
    'tutorial_start',
    {
      title: 'Start recording a tutorial',
      description:
        'Begins a screen recording in a browser that is signed in via a saved profile. ' +
        'Everything you do with the other tutorial_* tools is captured. ' +
        'Narrate with tutorial_say as you go, then call tutorial_finish to render the video. ' +
        'Only one recording can run at a time.',
      inputSchema: {
        title: z.string().min(1).describe('Tutorial title; also names the output folder.'),
        url: z.string().url().optional().describe('Page to open first.'),
        profile: z
          .string()
          .default('default')
          .describe('Browser profile holding the logins. Sign in once with the login command.'),
        resolution: z
          .enum(['720p', '1080p', '1440p'])
          .default('1080p')
          .describe('Recording resolution.'),
        headless: z
          .boolean()
          .default(true)
          .describe('Keep the browser invisible so the machine stays usable. Turn off only if a site blocks headless browsers.'),
        voiceId: z.string().optional().describe('ElevenLabs voice id for narration.'),
        music: z
          .boolean()
          .default(true)
          .describe('Lay background music under the narration.'),
        showActions: z
          .boolean()
          .default(true)
          .describe('Draw an animated pointer and caption each action.'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    async args => {
      const existing = getSession()
      if (existing && !existing.isFinished) {
        return failure(
          `A recording is already running ("${existing.title}"). ` +
            'Finish it with tutorial_finish or discard it with tutorial_cancel.',
        )
      }

      const preset = PRESETS[args.resolution]
      try {
        const session = await RecordingSession.start(config, {
          title: args.title,
          profile: args.profile,
          width: preset.width,
          height: preset.height,
          deviceScaleFactor: preset.deviceScaleFactor,
          headless: args.headless,
          voiceId: args.voiceId ?? config.defaultVoiceId,
          modelId: config.defaultModelId,
          music: args.music ? config.defaultMusic : null,
          musicGainDb: 0,
          showActions: args.showActions,
          quality: 92,
        })
        setSession(session)

        if (args.url) {
          await session.page.goto(args.url, { waitUntil: 'domcontentloaded' })
        }

        const warnings: string[] = []
        if (!config.elevenLabsApiKey) {
          warnings.push(
            'No ELEVENLABS_API_KEY is set, so narration will be silent - tutorial_say will still ' +
              'pace the recording correctly, and captions will be written.',
          )
        }
        if (args.music && !config.defaultMusic) {
          warnings.push('No background music file was found in assets/music.')
        }

        return text(
          [
            `Recording "${args.title}" at ${preset.width}x${preset.height}.`,
            args.url ? `Opened ${args.url}.` : 'No page opened yet - use tutorial_goto.',
            `Output folder: ${session.outputDir}`,
            ...warnings.map(w => `Note: ${w}`),
          ].join('\n'),
        )
      } catch (err) {
        return failure(`Could not start the recording: ${(err as Error).message}`)
      }
    },
  )

  server.registerTool(
    'tutorial_say',
    {
      title: 'Narrate a line',
      description:
        'Speaks a line of narration over the recording. The audio is generated first and the ' +
        'recording then waits for exactly as long as the speech takes, so the voice always ' +
        'matches what is on screen. Say what the viewer is about to see, then perform the action.',
      inputSchema: {
        text: z.string().min(1).describe('What to say. One or two sentences reads best.'),
        pauseAfterMs: z
          .number()
          .int()
          .min(0)
          .max(10_000)
          .default(350)
          .describe('Extra silence after the line, to let the picture breathe.'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    async args => {
      let session
      try {
        session = requireSession()
      } catch (err) {
        return failure((err as Error).message)
      }

      const atMs = session.videoTimeMs
      const index = session.cues.length
      let audioFile: string | null = null
      let durationMs: number

      if (config.elevenLabsApiKey) {
        try {
          const result = await synthesise(config, {
            text: args.text,
            voiceId: session.options.voiceId,
            modelId: session.options.modelId,
          })
          // Copy into the session so it can be re-composed later on its own.
          const local = path.join(
            session.outputDir,
            'audio',
            `${String(index).padStart(3, '0')}.mp3`,
          )
          fs.copyFileSync(result.file, local)
          audioFile = local
          durationMs = result.durationMs
        } catch (err) {
          log.warn('Narration failed; pacing with an estimate instead', err)
          durationMs = estimateSpokenMs(args.text)
        }
      } else {
        durationMs = estimateSpokenMs(args.text)
      }

      session.addCue({
        atMs,
        text: args.text,
        audioFile,
        durationMs,
        voiceId: session.options.voiceId,
      })

      // The recording genuinely waits, so picture and sound cannot drift apart.
      await session.page.waitForTimeout(durationMs + args.pauseAfterMs)

      return text(
        `Narrated at ${(atMs / 1000).toFixed(1)}s for ${(durationMs / 1000).toFixed(1)}s` +
          (audioFile ? '.' : ' (silent - no API key; the pacing is still correct).'),
      )
    },
  )

  server.registerTool(
    'tutorial_chapter',
    {
      title: 'Show a chapter card',
      description:
        'Displays a centred title card over a blurred backdrop. Good for opening the video ' +
        'or separating major steps.',
      inputSchema: {
        title: z.string().min(1).describe('Heading shown large.'),
        description: z.string().optional().describe('Smaller line beneath the heading.'),
        durationMs: z.number().int().min(500).max(10_000).default(2200),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    async args => {
      try {
        const session = requireSession()
        await session.showChapter(args.title, args.description, args.durationMs)
        await session.page.waitForTimeout(args.durationMs)
        return text(`Chapter card shown: "${args.title}".`)
      } catch (err) {
        return failure((err as Error).message)
      }
    },
  )

  server.registerTool(
    'tutorial_finish',
    {
      title: 'Finish and render the tutorial',
      description:
        'Stops the recording, mixes narration and music under the picture, and renders the ' +
        'final mp4. Returns the path to the finished file. This can take a minute or two.',
      inputSchema: {
        subtitles: z
          .boolean()
          .default(true)
          .describe('Also write a subtitle track from the narration.'),
        musicGainDb: z
          .number()
          .min(-20)
          .max(20)
          .default(0)
          .describe(
            'Fine-tune the music level in dB. It is already normalised to sit under the ' +
              'voice, so 0 is right unless a particular track needs nudging.',
          ),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    async args => {
      let session
      try {
        session = requireSession()
      } catch (err) {
        return failure((err as Error).message)
      }

      try {
        const { rawVideo, videoMs } = await session.stopRecording()
        session.writeTimeline()

        if (!rawVideo) {
          setSession(null)
          return failure(
            'The recording produced no video file. The page may never have painted.',
          )
        }

        const result = await compose(config, {
          rawVideo,
          cues: session.cues,
          outputDir: session.outputDir,
          music: session.options.music,
          musicGainDb: args.musicGainDb,
          subtitles: args.subtitles,
        })

        const check = await verifyOutput(config, result.outputFile)
        setSession(null)

        const lines = [
          `Finished "${session.title}".`,
          `File: ${result.outputFile}`,
          `${result.durationSec.toFixed(1)}s, ${result.width}x${result.height}, ` +
            `${result.cueCount} narration lines, audio ${result.hasAudio ? 'mixed' : 'absent'}.`,
          `Recorded ${(videoMs / 1000).toFixed(1)}s across ${session.frameCount} frames.`,
        ]
        if (!check.ok) {
          lines.push('', 'Warning - the finished video looks wrong:')
          lines.push(...check.problems.map(p => `  - ${p}`))
        }

        return {
          content: [
            { type: 'text' as const, text: lines.join('\n') },
            {
              type: 'resource_link' as const,
              uri: pathToFileURL(result.outputFile).href,
              name: path.basename(result.outputFile),
              mimeType: 'video/mp4',
            },
          ],
        }
      } catch (err) {
        setSession(null)
        return failure(`Rendering failed: ${(err as Error).message}`)
      }
    },
  )

  server.registerTool(
    'tutorial_cancel',
    {
      title: 'Discard the current recording',
      description: 'Stops the recording and closes the browser without rendering anything.',
      inputSchema: {},
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
    },
    async () => {
      const session = getSession()
      if (!session || session.isFinished) return text('No recording is running.')
      await session.cancel()
      setSession(null)
      return text(`Discarded "${session.title}". Working files remain in ${session.outputDir}.`)
    },
  )

  server.registerTool(
    'tutorial_status',
    {
      title: 'Recording status',
      description: 'Reports whether a recording is running and what it has captured so far.',
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async () => {
      const session = getSession()
      if (!session || session.isFinished) {
        return text('No recording is running. Start one with tutorial_start.')
      }
      const s = session.summary()
      return text(
        [
          `Recording "${s.title}"`,
          `  elapsed:   ${(s.videoMs / 1000).toFixed(1)}s (${s.frames} frames)`,
          `  narration: ${s.cueCount} lines totalling ${(s.narratedMs / 1000).toFixed(1)}s`,
          `  folder:    ${s.outputDir}`,
        ].join('\n'),
      )
    },
  )

  server.registerTool(
    'tutorial_voices',
    {
      title: 'List narration voices',
      description: 'Lists the ElevenLabs voices available for narration.',
      inputSchema: {
        search: z.string().optional().describe('Filter by name or description.'),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async args => {
      try {
        const voices = await listVoices(config)
        const needle = args.search?.toLowerCase()
        const filtered = needle
          ? voices.filter(v =>
              `${v.name} ${v.description ?? ''} ${Object.values(v.labels).join(' ')}`
                .toLowerCase()
                .includes(needle),
            )
          : voices

        if (filtered.length === 0) return text('No voices matched.')
        return text(
          filtered
            .map(v => {
              const labels = Object.entries(v.labels)
                .map(([k, val]) => `${k}=${val}`)
                .join(', ')
              return `${v.name}  [${v.voiceId}]\n  ${labels || v.category}`
            })
            .join('\n'),
        )
      } catch (err) {
        return failure((err as Error).message)
      }
    },
  )
}
