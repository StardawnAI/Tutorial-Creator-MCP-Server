/**
 * Record a tutorial from a script file, through a freshly started MCP server.
 *
 *   node scripts/record.mjs scripts/scripts/overview.json
 *
 * Useful when the MCP server already running inside an editor was started before
 * `.env` changed - a server process reads its configuration once, so a key added
 * afterwards only reaches a new process.
 *
 * Script format:
 *   {
 *     "start":  { "title": "...", "url": "...", "resolution": "1080p", ... },
 *     "steps":  [ { "tool": "tutorial_say", "args": { "text": "..." } }, ... ],
 *     "finish": { "subtitles": true }
 *   }
 */

import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

const scriptPath = process.argv[2]
if (!scriptPath) {
  process.stderr.write('usage: node scripts/record.mjs <script.json>\n')
  process.exit(1)
}
const plan = JSON.parse(fs.readFileSync(path.resolve(scriptPath), 'utf8'))

const server = spawn(process.execPath, [path.join(root, 'dist', 'index.js')], {
  stdio: ['pipe', 'pipe', 'pipe'],
})

let buffer = ''
let stderr = ''
const pending = new Map()

server.stdout.on('data', chunk => {
  buffer += chunk.toString()
  const lines = buffer.split('\n')
  buffer = lines.pop() ?? ''
  for (const line of lines) {
    if (!line.trim()) continue
    try {
      const msg = JSON.parse(line)
      const waiter = pending.get(msg.id)
      if (waiter) { pending.delete(msg.id); waiter(msg) }
    } catch { /* not JSON-RPC */ }
  }
})
server.stderr.on('data', c => { stderr += c.toString() })

let nextId = 1
function rpc(method, params = {}, timeoutMs = 600_000) {
  const id = nextId++
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${method} timed out`)), timeoutMs)
    pending.set(id, msg => { clearTimeout(timer); resolve(msg) })
    server.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
  })
}

async function call(name, args = {}) {
  const res = await rpc('tools/call', { name, arguments: args })
  const body = res?.result?.content?.find(c => c.type === 'text')?.text ?? ''
  const failed = res?.result?.isError === true
  const first = body.split('\n')[0]
  process.stdout.write(`  ${failed ? '!' : '>'} ${name.padEnd(20)} ${first}\n`)
  if (failed) throw new Error(`${name}: ${body}`)
  return res.result
}

async function waitForReady(timeoutMs = 30_000) {
  const start = Date.now()
  while (!stderr.includes('server ready')) {
    if (Date.now() - start > timeoutMs) throw new Error(`server never started:\n${stderr}`)
    await new Promise(r => setTimeout(r, 50))
  }
}

async function main() {
  process.stdout.write(`Recording from ${path.basename(scriptPath)}\n\n`)
  await waitForReady()

  // Surface how the fresh process resolved its configuration - this is the whole
  // reason for recording through a new server rather than a long-lived one.
  const config = stderr.split('\n').find(l => l.includes('elevenlabs='))
  if (config) process.stdout.write(`  ${config.replace(/^\[tutorial-mcp\] INFO /, '')}\n\n`)

  await rpc('initialize', {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'record', version: '1.0.0' },
  })
  server.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`)

  await call('tutorial_start', plan.start)
  for (const step of plan.steps) {
    await call(step.tool, step.args ?? {})
  }
  const finish = await call('tutorial_finish', plan.finish ?? {})

  const summary = finish.content.find(c => c.type === 'text')?.text ?? ''
  const link = finish.content.find(c => c.type === 'resource_link')
  const spoken = stderr.match(/Narrated \d+ bytes/g)?.length ?? 0

  process.stdout.write(`\n${summary}\n`)
  process.stdout.write(`\nNarration clips synthesised: ${spoken}\n`)
  if (link) process.stdout.write(`Video: ${fileURLToPath(link.uri)}\n`)

  server.kill()
  process.exit(0)
}

main().catch(err => {
  server.kill()
  process.stderr.write(`\nrecording failed: ${err.message}\n`)
  process.stderr.write(`\nserver stderr tail:\n${stderr.slice(-1500)}\n`)
  process.exit(1)
})
