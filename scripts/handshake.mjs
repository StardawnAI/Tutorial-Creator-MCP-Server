/**
 * Protocol smoke test: start the server over stdio, complete the MCP handshake and
 * list the tools. Also asserts that nothing but JSON-RPC reaches stdout - a single
 * stray print corrupts the transport and the client silently disconnects.
 *
 *   node scripts/handshake.mjs
 */

import { spawn } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const server = spawn(process.execPath, [path.join(root, 'dist', 'index.js')], {
  stdio: ['pipe', 'pipe', 'pipe'],
  env: { ...process.env, TUTORIAL_MCP_LOG_LEVEL: 'info' },
})

let stdout = ''
let stderr = ''
const pending = new Map()

server.stdout.on('data', chunk => {
  stdout += chunk.toString()
  // Responses are newline-delimited JSON; resolve whoever is waiting for each id.
  const lines = stdout.split('\n')
  stdout = lines.pop() ?? ''
  for (const line of lines) {
    if (!line.trim()) continue
    let message
    try {
      message = JSON.parse(line)
    } catch {
      junk.push(line)
      continue
    }
    received.push(message)
    const waiter = pending.get(message.id)
    if (waiter) {
      pending.delete(message.id)
      waiter(message)
    }
  }
})
server.stderr.on('data', chunk => {
  stderr += chunk.toString()
})

const junk = []
const received = []

const send = obj => server.stdin.write(`${JSON.stringify(obj)}\n`)

function request(id, method, params = {}, timeoutMs = 15_000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`No response to ${method} within ${timeoutMs}ms`)),
      timeoutMs,
    )
    pending.set(id, msg => {
      clearTimeout(timer)
      resolve(msg)
    })
    send({ jsonrpc: '2.0', id, method, params })
  })
}

/** The server resolves ffmpeg by executing it, so startup takes a moment. */
function waitForReady(timeoutMs = 30_000) {
  return new Promise((resolve, reject) => {
    const started = Date.now()
    const poll = setInterval(() => {
      if (stderr.includes('server ready')) {
        clearInterval(poll)
        resolve(Date.now() - started)
      } else if (Date.now() - started > timeoutMs) {
        clearInterval(poll)
        reject(new Error(`Server did not report ready.\nstderr:\n${stderr}`))
      }
    }, 50)
  })
}

const results = []
const check = (label, ok, detail = '') => {
  results.push(ok)
  process.stdout.write(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${detail ? ` - ${detail}` : ''}\n`)
}

async function main() {
  process.stdout.write('MCP protocol check\n\n')

  const startupMs = await waitForReady()
  check('server starts and reports ready', true, `${startupMs}ms`)

  const init = await request(1, 'initialize', {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'handshake-test', version: '1.0.0' },
  })
  check(
    'server answered initialize',
    Boolean(init?.result),
    init?.result?.serverInfo
      ? `${init.result.serverInfo.name} v${init.result.serverInfo.version}`
      : JSON.stringify(init).slice(0, 120),
  )
  check('server declares instructions for the agent', Boolean(init?.result?.instructions))

  send({ jsonrpc: '2.0', method: 'notifications/initialized' })

  const toolsMsg = await request(2, 'tools/list')
  const list = toolsMsg?.result?.tools ?? []
  check('tools/list returned tools', list.length > 0, `${list.length} tools`)

  const expected = [
    'tutorial_start', 'tutorial_say', 'tutorial_chapter', 'tutorial_finish',
    'tutorial_cancel', 'tutorial_status', 'tutorial_voices',
    'tutorial_goto', 'tutorial_click', 'tutorial_type', 'tutorial_press',
    'tutorial_scroll', 'tutorial_wait', 'tutorial_snapshot', 'tutorial_screenshot',
    'tutorial_highlight',
  ]
  const names = list.map(t => t.name)
  const missing = expected.filter(n => !names.includes(n))
  check('every expected tool is registered', missing.length === 0,
    missing.length ? `missing: ${missing.join(', ')}` : `${names.length} present`)

  const thin = list.filter(t => !t.description || t.description.length < 30)
  check('every tool has a real description', thin.length === 0, thin.map(t => t.name).join(', '))

  const noSchema = list.filter(t => !t.inputSchema)
  check('every tool has an input schema', noSchema.length === 0, noSchema.map(t => t.name).join(', '))

  // Calling a tool with no recording running must come back as a clean error,
  // not a crash or a protocol-level exception.
  const noSession = await request(3, 'tools/call', { name: 'tutorial_status', arguments: {} })
  check(
    'tools work with no recording running',
    Boolean(noSession?.result?.content?.[0]?.text),
    noSession?.result?.content?.[0]?.text?.slice(0, 60),
  )

  const badCall = await request(4, 'tools/call', { name: 'tutorial_say', arguments: { text: 'x' } })
  check(
    'narrating without a session fails cleanly',
    badCall?.result?.isError === true,
    badCall?.result?.content?.[0]?.text?.slice(0, 60),
  )

  check('stdout carried only JSON-RPC', junk.length === 0,
    junk.length ? `${junk.length} stray line(s): ${junk[0]?.slice(0, 80)}` : '')
  check('logging went to stderr', stderr.includes('tutorial-mcp'))

  server.kill()
  const failed = results.filter(r => !r).length
  process.stdout.write(`\n${results.length - failed}/${results.length} checks passed\n`)
  if (failed === 0) process.stdout.write(`\nTools: ${names.join(', ')}\n`)
  process.exit(failed > 0 ? 1 : 0)
}

main().catch(err => {
  server.kill()
  process.stderr.write(`\nhandshake failed: ${err.message}\n`)
  process.exit(1)
})
