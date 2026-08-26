/**
 * Full tutorial recorded through the MCP protocol itself - the same path Claude
 * Code takes. Exercises tutorial_start, narration, browser actions and
 * tutorial_finish against a local test page.
 *
 *   node scripts/live-run.mjs
 *
 * Works with or without a valid ElevenLabs key: without one the narration is
 * silent but the recording is still paced and captioned, and this script says so.
 */

import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

const PAGE = `<!doctype html><meta charset="utf-8"><title>Example App - Account</title>
<style>
 *{box-sizing:border-box}
 body{font:16px/1.6 system-ui,sans-serif;margin:0;background:#f8fafc;color:#0f172a}
 header{background:#fff;border-bottom:1px solid #e2e8f0;padding:18px 40px;display:flex;
        justify-content:space-between;align-items:center}
 .brand{font-weight:700;font-size:19px}
 main{padding:44px 40px;max-width:680px}
 h1{font-size:26px;margin:0 0 6px}
 .lead{color:#64748b;margin:0 0 30px}
 label{display:block;margin:18px 0 6px;font-weight:600;font-size:14px}
 input{width:100%;padding:12px 14px;border:1px solid #cbd5e1;border-radius:8px;font-size:15px;background:#fff}
 button{margin-top:26px;padding:12px 24px;border:0;border-radius:8px;background:#2563eb;
        color:#fff;font-size:15px;font-weight:600;cursor:pointer}
 #done{margin-top:22px;padding:15px;border-radius:8px;background:#dcfce7;color:#166534;
       display:none;font-weight:600}
</style>
<header><span class="brand">Example App</span><span>Signed in as jim</span></header>
<main>
  <h1>Verify your account</h1>
  <p class="lead">Confirm your email address to unlock all features.</p>
  <label for="email">Email address</label>
  <input id="email" placeholder="you@example.com">
  <label for="code">Verification code</label>
  <input id="code" placeholder="6-digit code">
  <button id="verify">Verify account</button>
  <div id="done">Your account is verified.</div>
</main>
<script>
 document.getElementById('verify').onclick = () =>
   document.getElementById('done').style.display = 'block';
</script>`

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tutorial-live-'))
const pageFile = path.join(tmp, 'app.html')
fs.writeFileSync(pageFile, PAGE)
const pageUrl = pathToFileURL(pageFile).href

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
    } catch { /* ignore non-JSON */ }
  }
})
server.stderr.on('data', c => { stderr += c.toString() })

let nextId = 1
function rpc(method, params = {}, timeoutMs = 300_000) {
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
  process.stdout.write(`  ${failed ? '!' : '>'} ${name}: ${body.split('\n')[0]}\n`)
  if (failed) throw new Error(`${name} failed: ${body}`)
  return res.result
}

async function waitForReady() {
  const start = Date.now()
  while (!stderr.includes('server ready')) {
    if (Date.now() - start > 30_000) throw new Error(`server never started:\n${stderr}`)
    await new Promise(r => setTimeout(r, 50))
  }
}

async function main() {
  process.stdout.write('Recording a tutorial through the MCP protocol\n\n')
  await waitForReady()
  await rpc('initialize', {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'live-run', version: '1.0.0' },
  })
  server.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`)

  await call('tutorial_start', {
    title: 'Verify your account',
    url: pageUrl,
    profile: 'live-test',
    resolution: '720p',
  })

  await call('tutorial_chapter', {
    title: 'Verify your account',
    description: 'Three steps, about a minute',
  })

  await call('tutorial_say', { text: 'First, enter the email address you signed up with.' })
  await call('tutorial_type', { selector: '#email', value: 'jim@example.com' })

  await call('tutorial_say', { text: 'Next, type the six digit code from your inbox.' })
  // Marked sensitive: the on-screen action caption is suppressed so the code
  // does not end up readable in the video.
  await call('tutorial_type', { selector: '#code', value: '482913', sensitive: true })

  await call('tutorial_say', { text: 'Finally, click the verify button to confirm.' })
  await call('tutorial_highlight', { selector: '#verify' })
  await call('tutorial_click', { selector: '#verify' })

  await call('tutorial_say', { text: 'That is it. Your account is now verified.' })

  const finish = await call('tutorial_finish', {})
  const link = finish.content.find(c => c.type === 'resource_link')

  process.stdout.write('\n')
  const summary = finish.content.find(c => c.type === 'text')?.text ?? ''
  process.stdout.write(`${summary}\n`)

  const narrated = stderr.match(/Narrated \d+ bytes/g)?.length ?? 0
  process.stdout.write(
    `\nNarration clips actually synthesised: ${narrated}` +
      (narrated === 0 ? '  (silent - the API key was rejected or absent)' : '') + '\n',
  )
  if (link) process.stdout.write(`Video: ${fileURLToPath(link.uri)}\n`)

  server.kill()
  fs.rmSync(tmp, { recursive: true, force: true })
  process.exit(0)
}

main().catch(err => {
  server.kill()
  process.stderr.write(`\nlive run failed: ${err.message}\n`)
  process.stderr.write(`\nserver stderr tail:\n${stderr.slice(-2000)}\n`)
  process.exit(1)
})
