/**
 * Setup tools: getting a signed-in session into the recording browser.
 */

import os from 'node:os'
import path from 'node:path'
import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { Config } from '../lib/env.js'
import { importSession, listProfiles } from '../lib/session-import.js'

function text(body: string) {
  return { content: [{ type: 'text' as const, text: body }] }
}

function failure(body: string) {
  return { content: [{ type: 'text' as const, text: body }], isError: true }
}

/** A scratch path the caller can hand to the exporting browser. */
function suggestedExportPath(): string {
  return path.join(os.tmpdir(), 'tutorial-session.json')
}

export function registerSetupTools(server: McpServer, config: Config): void {
  server.registerTool(
    'tutorial_import_session',
    {
      title: 'Copy a signed-in session into the recording browser',
      description:
        'Takes a session exported from a browser that is already signed in and puts it into ' +
        'the recording profile, so recordings need no separate login.\n\n' +
        'Use this when a recording needs an app the user is logged into. If a Playwright MCP ' +
        'server is available that drives the real browser, export the session there first.\n\n' +
        'IMPORTANT - open the site BEFORE exporting:\n' +
        "  await page.goto('https://the-app.com')\n" +
        "  await page.context().storageState({ path: '<file>' })\n" +
        'storageState only collects page storage (localStorage) for origins that are actually ' +
        'loaded. Exporting without opening the site first yields cookies alone, and any app ' +
        'that keeps its login token in page storage will then appear signed out.\n\n' +
        'Then call this tool with that path and the domains you need.\n\n' +
        'Always pass `domains` — an unfiltered export carries every site the user is signed ' +
        'into, and a tutorial needs one. The export file is deleted after it is read. ' +
        'Never print the file contents; it is a credential dump.',
      inputSchema: {
        stateFile: z
          .string()
          .describe(`Path to the exported storageState JSON. Suggested: ${suggestedExportPath()}`),
        domains: z
          .array(z.string())
          .optional()
          .describe(
            'Hosts to import, e.g. ["app.example.com"]. Omit only when you really need everything.',
          ),
        profile: z.string().default('default').describe('Recording profile to write into.'),
        verifyUrl: z
          .string()
          .url()
          .optional()
          .describe('Page to open afterwards to confirm the session carried over.'),
        deleteSourceFile: z
          .boolean()
          .default(true)
          .describe('Delete the export once imported. Leave on unless debugging.'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    async args => {
      try {
        const result = await importSession(config, {
          stateFile: args.stateFile,
          profile: args.profile,
          domains: args.domains,
          deleteSourceFile: args.deleteSourceFile,
          verifyUrl: args.verifyUrl,
        })

        const lines = [
          `Imported ${result.imported} cookies into profile "${args.profile}".`,
          `Domains: ${result.byDomain.map(d => `${d.domain} (${d.count})`).join(', ')}`,
        ]
        if (result.skipped > 0) {
          lines.push(`Left out ${result.skipped} cookies (other domains, or expired).`)
        }
        lines.push(
          result.sourceDeleted
            ? 'The export file has been deleted.'
            : 'WARNING: the export file is still on disk and contains live credentials.',
        )

        if (result.verification) {
          const v = result.verification
          lines.push('', `Checked ${v.url}`, `  page title: ${v.title}`)
          if (v.redirectedToLogin) {
            lines.push(
              '  redirected to a sign-in page - the session did NOT carry over. Some apps keep ' +
                'their login in localStorage or tie it to the device; those need a one-time ' +
                '`npm run login -- --url <site>` instead.',
            )
          } else if (!v.looksSignedIn) {
            lines.push('  a sign-in form is on the page - the session did NOT carry over.')
          } else if (!v.conclusive) {
            lines.push(
              '  the page loaded, but it is reachable without an account, so this does not ' +
                'prove anything. Verify against a page that requires signing in.',
            )
          } else {
            lines.push('  loaded without being sent to a login page - the session carried over.')
          }
        } else {
          lines.push(
            '',
            'Pass verifyUrl next time - ideally a page that requires an account - to confirm ' +
              'the session actually works before recording against it.',
          )
        }

        if (result.missingPageStorage) {
          lines.push(
            '',
            'The export carried no page storage for these domains. That normally means the site ' +
              'was not open in the exporting browser when the export was taken. If the app turns ' +
              'out to be signed out, redo the export with the site loaded first: ' +
              "page.goto('https://<the-app>') and then storageState({ path }).",
          )
        } else {
          lines.push(
            `Page storage restored for ${result.localStorageOrigins} origin(s), so logins kept ` +
              'in localStorage carry over too.',
          )
        }

        return text(lines.join('\n'))
      } catch (err) {
        return failure(`Session import failed: ${(err as Error).message}`)
      }
    },
  )

  server.registerTool(
    'tutorial_profiles',
    {
      title: 'List recording profiles',
      description:
        'Lists the browser profiles available for recording and whether each holds any ' +
        'saved session data.',
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async () => {
      const profiles = listProfiles(config)
      if (profiles.length === 0) {
        return text(
          'No profiles yet. Import a session with tutorial_import_session, or run ' +
            '`npm run login -- --url <site>` to sign in by hand.',
        )
      }
      return text(
        profiles
          .map(p => `${p.name}${p.hasData ? '' : '  (empty - no session data yet)'}`)
          .join('\n'),
      )
    },
  )
}
