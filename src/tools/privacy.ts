/**
 * Tools that decide what stays out of the picture.
 *
 * The platform schema and the personal-data detectors already grey out other people's
 * content and cover addresses, numbers and keys on their own. What they cannot know is
 * what this particular tutorial is about - that is what these tools are for.
 */

import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { Page } from 'playwright-core'
import { requireSession } from '../lib/session.js'
import { describePrivacy, type LocatedTarget } from '../lib/privacy.js'
import { TARGET_SHAPE, describeTarget, matchAll, resolveTarget, type Target } from './actions.js'

function text(body: string) {
  return { content: [{ type: 'text' as const, text: body }] }
}

function failure(body: string) {
  return { content: [{ type: 'text' as const, text: body }], isError: true }
}

const TargetList = z.array(z.object(TARGET_SHAPE)).optional()

/**
 * Split targets into plain CSS, which the page applies on first paint and for good,
 * and everything else, which has to be found from here and marked.
 */
async function sortTargets(
  page: Page,
  targets: Target[] = [],
): Promise<{ css: string[]; located: LocatedTarget[] }> {
  const css: string[] = []
  const located: LocatedTarget[] = []
  for (const target of targets) {
    const plain =
      target.selector !== undefined &&
      !target.role &&
      !target.text &&
      target.nth === undefined &&
      (await page
        .evaluate(selector => {
          try {
            document.querySelectorAll(selector)
            return true
          } catch {
            return false
          }
        }, target.selector)
        .catch(() => false))
    if (plain && target.selector) css.push(target.selector)
    else {
      located.push({
        label: describeTarget(target),
        locate: p => (target.nth === undefined ? matchAll(p, target) : resolveTarget(p, target)),
      })
    }
  }
  return { css, located }
}

export function registerPrivacyTools(server: McpServer): void {
  server.registerTool(
    'tutorial_privacy',
    {
      title: 'Decide what stays private',
      description:
        'Keeps things visible or greys them out, beyond what happens by itself.\n\n' +
        'By itself: cookie banners are answered with "reject"; on known platforms (Instagram, ' +
        'Facebook, WhatsApp, X, LinkedIn, YouTube, Gmail, Outlook, Slack, Telegram) and on ' +
        'any site that labels its lists for screen readers, other people\'s messages, ' +
        'conversations, posts, comments, notifications and profile pictures are greyed out; ' +
        'email addresses, phone numbers, IBANs, card numbers and API keys are covered with a ' +
        'grey bar on every site. Whatever is clicked, typed into or highlighted stays visible, ' +
        'with its whole post or conversation.\n\n' +
        'Use keep for what the tutorial is about but does not touch - the message that just ' +
        'arrived, the post being explained. Use hide for private things the automatic part ' +
        'misses, and hideText for names or handles to cover wherever they appear. Called ' +
        'without arguments, it reports what is currently kept out of the picture.\n\n' +
        'Plain CSS selectors take effect on the very first frame and survive re-rendering; ' +
        'roles, names and text are re-applied every second.',
      inputSchema: {
        keep: TargetList.describe('Elements to keep visible, with everything inside them.'),
        hide: TargetList.describe('Elements to grey out whatever else applies.'),
        hideText: z
          .array(z.string().min(2))
          .optional()
          .describe('Words to cover wherever they appear - a customer\'s name, an account handle.'),
        reset: z
          .boolean()
          .default(false)
          .describe('Forget everything kept and hidden with this tool before applying the rest.'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    async args => {
      try {
        const session = requireSession()
        const privacy = session.privacy
        if (!privacy) {
          return failure('Privacy is switched off for this recording (tutorial_start privacy: false).')
        }
        const keep = await sortTargets(session.page, args.keep)
        const hide = await sortTargets(session.page, args.hide)
        const changed =
          args.reset || keep.css.length + keep.located.length + hide.css.length + hide.located.length > 0 ||
          (args.hideText?.length ?? 0) > 0
        if (changed) {
          await session.updatePrivacy({
            reset: args.reset,
            keepCss: keep.css,
            hideCss: hide.css,
            hideText: args.hideText,
            keep: keep.located,
            hide: hide.located,
          })
          // Let a re-render settle before measuring what is covered.
          await session.page.waitForTimeout(150)
        }
        return text(describePrivacy(await privacy.report(session.page)))
      } catch (err) {
        return failure(`Could not change what stays private: ${(err as Error).message}`)
      }
    },
  )

  server.registerTool(
    'tutorial_camera',
    {
      title: 'Take the recording off camera',
      description:
        'live: false leaves everything that follows out of the video, across any number of ' +
        'tool calls, until live: true. For a sign-in, a setup step or anything else nobody ' +
        'needs to watch: the viewer sees the moment before and then the moment after, with ' +
        'no time passing in between.\n\n' +
        'Narration cannot be recorded while the camera is off. The browser keeps running, so ' +
        'every other tool works as usual; cookie banners and sign-in prompts are still ' +
        'answered.',
      inputSchema: {
        live: z.boolean().describe('false: off camera from now on. true: back on camera.'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    async args => {
      try {
        const session = requireSession()
        const changed = session.setLive(args.live)
        if (!changed) {
          return text(args.live ? 'The camera was already on.' : 'The camera was already off.')
        }
        return text(
          args.live
            ? `Back on camera at ${(session.videoTimeMs / 1000).toFixed(1)}s of the video, on ${session.page.url()}.`
            : 'Off camera: nothing is recorded into the video until tutorial_camera live: true.',
        )
      } catch (err) {
        return failure((err as Error).message)
      }
    },
  )
}
