/**
 * Bringing the recorder's window to the front, so the person answers the security
 * check in the browser being recorded and not in their own.
 *
 * This is the fix for a failure that wasted four recordings: the prompt said "please
 * solve it", the person solved it - in their own Chrome, where they were already
 * signed in - and the recorder went on waiting for a window nobody had looked at.
 *
 * Windows refuses `SetForegroundWindow` from a process that has not just received
 * input, and returns false without doing anything. Sending a synthetic Alt keypress
 * first is the documented way around it: it counts as input, and the call then works.
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { log } from './logger.js'

const run = promisify(execFile)

/**
 * Run from a file, not from `-Command`.
 *
 * Measured: handing PowerShell this script as one `-Command` argument loses the
 * quote in the `@"` that opens the C# block, and it dies on "Unbekanntes Token" -
 * `[DllImport]` needs a here-string and a here-string does not survive the trip.
 * A file has no quoting problem at all.
 */
const RAISE_SCRIPT = `param([string]$Needle)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class Fg {
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int c);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
}
"@
$window = Get-Process |
  Where-Object { $_.MainWindowTitle -and $_.MainWindowTitle -like "*$Needle*" } |
  Select-Object -First 1
if (-not $window) { Write-Output 'no-window'; exit 0 }
[System.Windows.Forms.SendKeys]::SendWait('%')
Start-Sleep -Milliseconds 80
[Fg]::ShowWindow($window.MainWindowHandle, 9) | Out-Null
[Fg]::SetForegroundWindow($window.MainWindowHandle) | Out-Null
Start-Sleep -Milliseconds 150
if ([Fg]::GetForegroundWindow() -eq $window.MainWindowHandle) {
  Write-Output "raised: $($window.MainWindowTitle)"
} else {
  Write-Output "refused: $($window.MainWindowTitle)"
}
`

/** Written once per process, next to the other temporary files. */
let scriptFile: string | null = null
function raiseScript(): string {
  if (scriptFile && fs.existsSync(scriptFile)) return scriptFile
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'tutorial-fg-')), 'raise.ps1')
  fs.writeFileSync(file, RAISE_SCRIPT, 'utf8')
  scriptFile = file
  return file
}

/**
 * Raise the window whose title contains `titleFragment`.
 *
 * Best effort by design: on anything but Windows, or when no window matches, the
 * caller still has a person to ask - it just has to say where to look.
 */
export async function raiseWindow(titleFragment: string): Promise<string> {
  if (process.platform !== 'win32') return 'unsupported'
  try {
    const { stdout } = await run(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', raiseScript(),
        '-Needle', titleFragment],
      { timeout: 20_000, windowsHide: true },
    )
    const answer = stdout.trim().split(/\r?\n/).pop() ?? ''
    log.info(`Foreground: ${answer}`)
    return answer
  } catch (err) {
    log.warn('Could not raise the recorder window', err)
    return 'failed'
  }
}
