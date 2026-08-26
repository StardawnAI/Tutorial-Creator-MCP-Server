#!/usr/bin/env node
/**
 * Tutorial Creator MCP server.
 *
 * Records narrated walkthrough videos of web apps: drives a signed-in browser,
 * speaks over what it is doing, and renders a finished mp4.
 *
 * stdio transport - stdout carries the JSON-RPC protocol, so nothing may be printed
 * to it. All logging goes to stderr via src/lib/logger.ts.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { loadConfig } from './lib/env.js'
import { getSession, setSession } from './lib/session.js'
import { registerRecordingTools } from './tools/recording.js'
import { registerActionTools } from './tools/actions.js'
import { log } from './lib/logger.js'

async function main(): Promise<void> {
  const config = loadConfig()

  const server = new McpServer(
    { name: 'tutorial-creator', version: '0.1.0' },
    {
      instructions:
        'Records narrated tutorial videos of web apps.\n\n' +
        'Workflow: tutorial_start, then drive the app with tutorial_goto / tutorial_click / ' +
        'tutorial_type while narrating each step with tutorial_say, then tutorial_finish.\n\n' +
        'Narrate before acting: say what the viewer is about to see, then perform the action. ' +
        'tutorial_say waits for the speech to finish, so the pacing takes care of itself.\n\n' +
        'Use tutorial_snapshot to see what is on the page before clicking. Mark passwords and ' +
        'verification codes as sensitive when typing so they are not captioned on screen.\n\n' +
        'The browser uses a saved profile for logins. If a site shows a sign-in page, the ' +
        'profile needs a one-time login - run the login command outside this session.',
    },
  )

  registerRecordingTools(server, config)
  registerActionTools(server)

  // A crashing recording must not leave an orphaned browser running.
  const cleanup = async (reason: string): Promise<void> => {
    const session = getSession()
    if (session && !session.isFinished) {
      log.warn(`Shutting down (${reason}) with a recording in progress - discarding it.`)
      await session.cancel().catch(() => {})
      setSession(null)
    }
  }
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => {
      void cleanup(signal).finally(() => process.exit(0))
    })
  }
  process.on('uncaughtException', err => {
    log.error('Uncaught exception', err)
    void cleanup('uncaughtException')
  })
  process.on('unhandledRejection', err => {
    log.error('Unhandled rejection', err)
  })

  const transport = new StdioServerTransport()
  await server.connect(transport)

  log.info('Tutorial Creator MCP server ready')
  log.info(
    `ffmpeg=${config.ffmpegPath ?? 'MISSING'} chromium=${config.chromiumPath ? 'ok' : 'MISSING'} ` +
      `elevenlabs=${config.elevenLabsApiKey ? 'ok' : 'no key'} ` +
      `music=${config.defaultMusic ? 'ok' : 'none'}`,
  )
}

main().catch(err => {
  log.error('Server failed to start', err)
  process.exit(1)
})
