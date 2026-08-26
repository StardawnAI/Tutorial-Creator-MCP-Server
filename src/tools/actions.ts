/**
 * Tools that drive the browser while it is being recorded.
 *
 * Every action is deliberately unhurried: the pointer glides to its target and the
 * caption naming the action stays up long enough to read. A tutorial that clicks at
 * machine speed teaches nobody anything.
 */

import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { Locator, Page } from 'playwright-core'
import { requireSession } from '../lib/session.js'
import { log } from '../lib/logger.js'

function text(body: string) {
  return { content: [{ type: 'text' as const, text: body }] }
}

function failure(body: string) {
  return { content: [{ type: 'text' as const, text: body }], isError: true }
}

/** Settle time after an action so the viewer can register what changed. */
const BEAT_MS = 600

const TARGET_SHAPE = {
  selector: z
    .string()
    .optional()
    .describe(
      'Playwright selector: CSS ("#email"), text ("text=Save changes") or ' +
        'role ("role=button[name=\\"Save\\"]").',
    ),
  text: z.string().optional().describe('Match by visible text instead of a selector.'),
  role: z.string().optional().describe('ARIA role, e.g. "button" or "link".'),
  name: z.string().optional().describe('Accessible name, used together with role.'),
  nth: z.number().int().min(0).optional().describe('Pick the nth match when several fit.'),
}

interface Target {
  selector?: string | undefined
  text?: string | undefined
  role?: string | undefined
  name?: string | undefined
  nth?: number | undefined
}

function resolveTarget(page: Page, target: Target): Locator {
  let locator: Locator
  if (target.selector) {
    locator = page.locator(target.selector)
  } else if (target.role) {
    locator = page.getByRole(target.role as Parameters<Page['getByRole']>[0], {
      ...(target.name ? { name: target.name } : {}),
    })
  } else if (target.text) {
    locator = page.getByText(target.text)
  } else {
    throw new Error('Say what to act on: selector, text, or role plus name.')
  }
  return target.nth === undefined ? locator.first() : locator.nth(target.nth)
}

function describeTarget(target: Target): string {
  if (target.selector) return target.selector
  if (target.role) return `${target.role}${target.name ? ` "${target.name}"` : ''}`
  if (target.text) return `text "${target.text}"`
  return 'target'
}

export function registerActionTools(server: McpServer): void {
  server.registerTool(
    'tutorial_goto',
    {
      title: 'Open a page',
      description: 'Navigates the recorded browser to a URL.',
      inputSchema: {
        url: z.string().url(),
        waitForMs: z
          .number()
          .int()
          .min(0)
          .max(30_000)
          .default(1200)
          .describe('Settle time after the page loads.'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    async args => {
      try {
        const session = requireSession()
        await session.page.goto(args.url, { waitUntil: 'domcontentloaded', timeout: 45_000 })
        await session.page.waitForTimeout(args.waitForMs)
        return text(`Opened ${args.url} (now at ${session.page.url()}).`)
      } catch (err) {
        return failure(`Navigation failed: ${(err as Error).message}`)
      }
    },
  )

  server.registerTool(
    'tutorial_click',
    {
      title: 'Click something',
      description:
        'Clicks an element. The recorded pointer glides to it first and the click is ' +
        'captioned, so the viewer can follow along.',
      inputSchema: { ...TARGET_SHAPE, waitForMs: z.number().int().min(0).max(30_000).default(BEAT_MS) },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    async args => {
      try {
        const session = requireSession()
        const locator = resolveTarget(session.page, args)
        await locator.scrollIntoViewIfNeeded({ timeout: 10_000 }).catch(() => {})
        await locator.click({ timeout: 20_000 })
        await session.page.waitForTimeout(args.waitForMs)
        return text(`Clicked ${describeTarget(args)}.`)
      } catch (err) {
        return failure(`Could not click ${describeTarget(args)}: ${(err as Error).message}`)
      }
    },
  )

  server.registerTool(
    'tutorial_type',
    {
      title: 'Type into a field',
      description:
        'Types text into a field, character by character so it reads naturally on video. ' +
        'Set sensitive when entering codes, passwords or personal data: the on-screen action ' +
        'caption is suppressed so the value is not spelled out in the recording.',
      inputSchema: {
        ...TARGET_SHAPE,
        value: z.string().describe('What to type.'),
        sensitive: z
          .boolean()
          .default(false)
          .describe('Suppress the action caption so the value stays out of the video.'),
        clearFirst: z.boolean().default(true).describe('Clear the field before typing.'),
        delayMs: z
          .number()
          .int()
          .min(0)
          .max(500)
          .default(70)
          .describe('Delay between keystrokes.'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    async args => {
      try {
        const session = requireSession()
        const page = session.page
        const locator = resolveTarget(page, args)
        await locator.scrollIntoViewIfNeeded({ timeout: 10_000 }).catch(() => {})

        // The action caption prints the typed value, which would put a verification
        // code or password on screen. Turn decorations off around sensitive input.
        const hideDecorations = args.sensitive && session.options.showActions
        if (hideDecorations) await page.screencast.hideActions().catch(() => {})

        try {
          if (args.clearFirst) await locator.fill('')
          await locator.pressSequentially(args.value, { delay: args.delayMs, timeout: 30_000 })
        } finally {
          if (hideDecorations) {
            await page.screencast
              .showActions({ cursor: 'pointer', duration: 800 })
              .catch(err => log.warn('Could not restore action decorations', err))
          }
        }

        await page.waitForTimeout(BEAT_MS)
        const shown = args.sensitive ? `${args.value.length} characters` : `"${args.value}"`
        return text(`Typed ${shown} into ${describeTarget(args)}.`)
      } catch (err) {
        return failure(`Could not type into ${describeTarget(args)}: ${(err as Error).message}`)
      }
    },
  )

  server.registerTool(
    'tutorial_press',
    {
      title: 'Press a key',
      description: 'Presses a keyboard key, e.g. "Enter", "Tab" or "Control+a".',
      inputSchema: {
        key: z.string().describe('Key name in Playwright notation.'),
        waitForMs: z.number().int().min(0).max(30_000).default(BEAT_MS),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    async args => {
      try {
        const session = requireSession()
        await session.page.keyboard.press(args.key)
        await session.page.waitForTimeout(args.waitForMs)
        return text(`Pressed ${args.key}.`)
      } catch (err) {
        return failure(`Could not press ${args.key}: ${(err as Error).message}`)
      }
    },
  )

  server.registerTool(
    'tutorial_scroll',
    {
      title: 'Scroll the page',
      description:
        'Scrolls smoothly, either by an amount or until an element is in view. Smooth ' +
        'scrolling reads far better on video than jumping.',
      inputSchema: {
        ...TARGET_SHAPE,
        direction: z.enum(['down', 'up', 'top', 'bottom']).optional(),
        amount: z.number().int().min(50).max(5000).default(600).describe('Pixels to scroll.'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    async args => {
      try {
        const session = requireSession()
        const page = session.page

        if (args.selector || args.text || args.role) {
          const locator = resolveTarget(page, args)
          await locator.scrollIntoViewIfNeeded({ timeout: 15_000 })
          await page.waitForTimeout(BEAT_MS)
          return text(`Scrolled ${describeTarget(args)} into view.`)
        }

        const direction = args.direction ?? 'down'
        await page.evaluate(
          ({ dir, amount }) => {
            const target =
              dir === 'top'
                ? 0
                : dir === 'bottom'
                  ? document.body.scrollHeight
                  : window.scrollY + (dir === 'up' ? -amount : amount)
            window.scrollTo({ top: target, behavior: 'smooth' })
          },
          { dir: direction, amount: args.amount },
        )
        // Smooth scrolling needs time to actually travel.
        await page.waitForTimeout(900)
        return text(`Scrolled ${direction}.`)
      } catch (err) {
        return failure(`Scrolling failed: ${(err as Error).message}`)
      }
    },
  )

  server.registerTool(
    'tutorial_wait',
    {
      title: 'Wait',
      description:
        'Holds the recording still, optionally until an element appears. Use it to let a ' +
        'page finish loading before narrating what is on it.',
      inputSchema: {
        ...TARGET_SHAPE,
        ms: z.number().int().min(0).max(60_000).default(1000),
        state: z.enum(['visible', 'hidden', 'attached']).default('visible'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    async args => {
      try {
        const session = requireSession()
        if (args.selector || args.text || args.role) {
          const locator = resolveTarget(session.page, args)
          await locator.waitFor({ state: args.state, timeout: Math.max(args.ms, 20_000) })
          return text(`${describeTarget(args)} is ${args.state}.`)
        }
        await session.page.waitForTimeout(args.ms)
        return text(`Waited ${args.ms}ms.`)
      } catch (err) {
        return failure(`Wait failed: ${(err as Error).message}`)
      }
    },
  )

  server.registerTool(
    'tutorial_snapshot',
    {
      title: 'See the page',
      description:
        'Returns the page structure as an accessibility tree, plus the title and URL. Use it ' +
        'to work out what to click before acting. Far cheaper than a screenshot.',
      inputSchema: {
        selector: z
          .string()
          .optional()
          .describe('Limit the snapshot to a region, e.g. "main" or "#content".'),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async args => {
      try {
        const session = requireSession()
        const page = session.page
        const root = args.selector ? page.locator(args.selector) : page.locator('body')
        const snapshot = await root.ariaSnapshot({ timeout: 15_000 })
        const trimmed =
          snapshot.length > 18_000
            ? `${snapshot.slice(0, 18_000)}\n… (truncated; narrow it with the selector argument)`
            : snapshot
        return text(`${await page.title()}\n${page.url()}\n\n${trimmed}`)
      } catch (err) {
        return failure(`Could not read the page: ${(err as Error).message}`)
      }
    },
  )

  server.registerTool(
    'tutorial_screenshot',
    {
      title: 'Look at the page',
      description:
        'Takes a screenshot of what is currently recorded. Use when the accessibility tree is ' +
        'not enough to tell what is on screen.',
      inputSchema: {
        fullPage: z.boolean().default(false).describe('Capture beyond the visible area.'),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async args => {
      try {
        const session = requireSession()
        const buffer = await session.page.screenshot({
          fullPage: args.fullPage,
          type: 'jpeg',
          quality: 70,
          scale: 'css',
        })
        return {
          content: [
            { type: 'image' as const, data: buffer.toString('base64'), mimeType: 'image/jpeg' },
          ],
        }
      } catch (err) {
        return failure(`Screenshot failed: ${(err as Error).message}`)
      }
    },
  )

  server.registerTool(
    'tutorial_highlight',
    {
      title: 'Draw attention to an element',
      description:
        'Outlines an element on screen for a moment, so the viewer knows where to look before ' +
        'anything happens.',
      inputSchema: {
        ...TARGET_SHAPE,
        durationMs: z.number().int().min(300).max(10_000).default(1600),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    async args => {
      try {
        const session = requireSession()
        const page = session.page
        const locator = resolveTarget(page, args)
        await locator.scrollIntoViewIfNeeded({ timeout: 10_000 }).catch(() => {})
        const box = await locator.boundingBox({ timeout: 10_000 })
        if (!box) return failure(`${describeTarget(args)} is not visible on the page.`)

        // `duration` removes the overlay on its own, so there is nothing to dispose.
        await page.screencast.showOverlay(
          `<div style="position:fixed;left:${box.x - 6}px;top:${box.y - 6}px;` +
            `width:${box.width + 12}px;height:${box.height + 12}px;` +
            'border:3px solid #38bdf8;border-radius:10px;' +
            'box-shadow:0 0 0 4px rgba(56,189,248,.25),0 0 0 9999px rgba(15,23,42,.35);' +
            'pointer-events:none"></div>',
          { duration: args.durationMs },
        )
        await page.waitForTimeout(args.durationMs)
        return text(`Highlighted ${describeTarget(args)}.`)
      } catch (err) {
        return failure(`Could not highlight ${describeTarget(args)}: ${(err as Error).message}`)
      }
    },
  )
}
