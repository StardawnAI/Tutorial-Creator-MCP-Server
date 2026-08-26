/**
 * Thin ffmpeg / ffprobe wrappers.
 *
 * Arguments are always passed as an array, never as a shell string, so paths
 * containing spaces (this project lives under "OneDrive - Stardawn") are safe.
 */

import { spawn } from 'node:child_process'
import { log } from './logger.js'

export interface RunResult {
  stdout: string
  stderr: string
}

export function run(binary: string, args: string[], timeoutMs = 15 * 60_000): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    log.debug(`${binary} ${args.map(a => (a.includes(' ') ? `"${a}"` : a)).join(' ')}`)
    const child = spawn(binary, args, { windowsHide: true })

    let stdout = ''
    let stderr = ''
    child.stdout.on('data', d => {
      stdout += d.toString()
    })
    child.stderr.on('data', d => {
      stderr += d.toString()
      // ffmpeg is chatty on stderr; keep only the tail so a long render does not
      // accumulate megabytes of progress lines in memory.
      if (stderr.length > 64_000) stderr = stderr.slice(-32_000)
    })

    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      reject(new Error(`${binary} timed out after ${Math.round(timeoutMs / 1000)}s`))
    }, timeoutMs)

    child.on('error', err => {
      clearTimeout(timer)
      reject(new Error(`Failed to launch ${binary}: ${err.message}`))
    })

    child.on('close', code => {
      clearTimeout(timer)
      if (code === 0) resolve({ stdout, stderr })
      else reject(new Error(`${binary} exited with code ${code}\n${stderr.slice(-4000)}`))
    })
  })
}

/** Media duration in seconds, or null when the file has none ffprobe can read. */
export async function probeDuration(ffprobePath: string, file: string): Promise<number | null> {
  const { stdout } = await run(
    ffprobePath,
    ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file],
    60_000,
  )
  const seconds = Number.parseFloat(stdout.trim())
  return Number.isFinite(seconds) ? seconds : null
}

export interface VideoInfo {
  width: number
  height: number
  durationSec: number
  codec: string
  frameRate: number
}

export async function probeVideo(ffprobePath: string, file: string): Promise<VideoInfo> {
  const { stdout } = await run(
    ffprobePath,
    [
      '-v', 'error',
      '-select_streams', 'v:0',
      '-show_entries', 'stream=width,height,codec_name,avg_frame_rate',
      '-show_entries', 'format=duration',
      '-of', 'json',
      file,
    ],
    60_000,
  )

  const parsed = JSON.parse(stdout) as {
    streams?: Array<{ width?: number; height?: number; codec_name?: string; avg_frame_rate?: string }>
    format?: { duration?: string }
  }
  const stream = parsed.streams?.[0]
  if (!stream) throw new Error(`No video stream found in ${file}`)

  const [num, den] = (stream.avg_frame_rate ?? '25/1').split('/').map(Number)
  const frameRate = den && den !== 0 ? (num ?? 25) / den : 25

  return {
    width: stream.width ?? 0,
    height: stream.height ?? 0,
    codec: stream.codec_name ?? 'unknown',
    durationSec: Number.parseFloat(parsed.format?.duration ?? '0') || 0,
    frameRate,
  }
}

/** Escape a value for use inside an ffmpeg filtergraph. */
export function escapeFilterValue(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/:/g, '\\:').replace(/'/g, "\\'")
}
