/**
 * A file dialog drawn into the page, for the moment a click opens a file picker.
 *
 * The operating system's own dialog is a window outside the browser: the screencast
 * never sees it, and filming the desktop instead would show the person's whole folder
 * and steal their screen. So the recording shows this stand-in - laid out like the
 * "Open" dialog of Windows 11, with the real folder name and the real files about to be
 * chosen (name, date, size), and nothing else from that folder - while the files
 * themselves reach the page through Playwright's file chooser.
 *
 * The words default to English. A recording in another language passes its own
 * (`pickerLabels` on tutorial_click), so the dialog matches the page around it.
 */

import fs from 'node:fs'
import path from 'node:path'
import type { Page } from 'playwright-core'

export interface PickerFile {
  name: string
  bytes: number
  modified: Date
}

export interface PickerLabels {
  title: string
  thisPc: string
  /** "{folder}" is replaced by the folder's name. */
  search: string
  newFolder: string
  home: string
  gallery: string
  desktop: string
  downloads: string
  documents: string
  pictures: string
  music: string
  videos: string
  name: string
  modified: string
  type: string
  size: string
  fileName: string
  allFiles: string
  open: string
  cancel: string
  /** "{ext}" is replaced by the extension in capitals, e.g. "GIF File". */
  fileType: string
}

export const DEFAULT_PICKER_LABELS: PickerLabels = {
  title: 'Open',
  thisPc: 'This PC',
  search: 'Search {folder}',
  newFolder: 'New folder',
  home: 'Home',
  gallery: 'Gallery',
  desktop: 'Desktop',
  downloads: 'Downloads',
  documents: 'Documents',
  pictures: 'Pictures',
  music: 'Music',
  videos: 'Videos',
  name: 'Name',
  modified: 'Date modified',
  type: 'Type',
  size: 'Size',
  fileName: 'File name:',
  allFiles: 'All files (*.*)',
  open: 'Open',
  cancel: 'Cancel',
  fileType: '{ext} File',
}

/** The default words with the given ones laid over them; unknown keys are ignored. */
export function pickerLabels(overrides: Record<string, string> | undefined): PickerLabels {
  const labels = { ...DEFAULT_PICKER_LABELS }
  for (const key of Object.keys(labels) as Array<keyof PickerLabels>) {
    const value = overrides?.[key]
    if (typeof value === 'string' && value.trim()) labels[key] = value
  }
  return labels
}

/** Name, size and date of each file, read from disk. */
export function describeFiles(files: string[]): PickerFile[] {
  return files.map(file => {
    const stat = fs.statSync(file)
    return { name: path.basename(file), bytes: stat.size, modified: stat.mtime }
  })
}

/** Size the way Explorer's details view shows it: whole kilobytes, rounded up. */
export function formatSize(bytes: number, locale: string): string {
  const kb = Math.max(1, Math.ceil(bytes / 1024))
  return `${new Intl.NumberFormat(locale, { maximumFractionDigits: 0 }).format(kb)} KB`
}

export function formatModified(date: Date, locale: string): string {
  return new Intl.DateTimeFormat(locale, {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })
    .format(date)
    .replace(',', '')
}

export function fileTypeLabel(name: string, labels: PickerLabels): string {
  const ext = path.extname(name).replace('.', '').toUpperCase()
  return ext ? labels.fileType.replace('{ext}', ext) : labels.fileType.replace('{ext}', '').trim()
}

const escapeHtml = (s: string): string =>
  s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!)

const FOLDER_ICON =
  '<svg viewBox="0 0 20 16" aria-hidden="true"><path d="M1 3a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2z" fill="#f8c947"/><path d="M1 6h18v7a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2z" fill="#ffd86b"/></svg>'
const FILE_ICON =
  '<svg viewBox="0 0 16 20" aria-hidden="true"><path d="M1 2a1 1 0 0 1 1-1h8l5 5v12a1 1 0 0 1-1 1H2a1 1 0 0 1-1-1z" fill="#fff" stroke="#8a8a8a"/><path d="M10 1v5h5" fill="#e6e6e6" stroke="#8a8a8a"/><rect x="3" y="10" width="10" height="6" rx="1" fill="#7a5cc4"/><path d="M4 15l3-3 2 2 1.5-1.5L12 15z" fill="#fff"/></svg>'

const STYLE = `
#tc-fp{position:fixed;inset:0;z-index:2147483600;display:flex;align-items:center;justify-content:center;pointer-events:none;
  font-family:"Segoe UI Variable Text","Segoe UI",system-ui,sans-serif;font-size:clamp(13px,.8vw,19px);color:#1b1b1b}
#tc-fp .win{width:clamp(760px,50vw,1240px);height:clamp(470px,31vw,770px);background:#f3f3f3;border:1px solid #bdbdbd;border-radius:9px;
  box-shadow:0 22px 60px rgba(0,0,0,.30),0 4px 14px rgba(0,0,0,.14);display:grid;grid-template-rows:auto auto auto 1fr auto;overflow:hidden;
  animation:tcfp-in 180ms ease-out;transition:opacity 150ms ease-in,transform 150ms ease-in}
#tc-fp.closing .win{opacity:0;transform:scale(.98)}
@keyframes tcfp-in{from{opacity:0;transform:scale(.97)}to{opacity:1;transform:none}}
#tc-fp .title{display:flex;align-items:center;justify-content:space-between;padding:.55em .9em .45em 1em;font-size:.95em}
#tc-fp .title .x{color:#444;font-size:1.05em;padding:0 .3em}
#tc-fp .nav{display:flex;align-items:center;gap:.5em;padding:.25em .9em .45em}
#tc-fp .nav .g{color:#5c5c5c;width:1.5em;text-align:center}
#tc-fp .addr{flex:1;display:flex;align-items:center;gap:.45em;background:#fff;border:1px solid #e1e1e1;border-radius:5px;padding:.38em .7em}
#tc-fp .addr .sep{color:#8a8a8a}
#tc-fp .search{width:28%;background:#fff;border:1px solid #e1e1e1;border-radius:5px;padding:.38em .7em;color:#767676}
#tc-fp .cmd{display:flex;gap:1.4em;padding:.4em 1em;border-top:1px solid #e5e5e5;border-bottom:1px solid #e5e5e5;background:#f9f9f9;color:#333}
#tc-fp .body{display:grid;grid-template-columns:13.5em 1fr;min-height:0;background:#fff}
#tc-fp .side{background:#f3f3f3;padding:.5em .4em;border-right:1px solid #e5e5e5}
#tc-fp .side div{display:flex;align-items:center;gap:.55em;padding:.32em .7em;border-radius:5px;position:relative}
#tc-fp .side div.on{background:#e3e3e3}
#tc-fp .side div.on::before{content:"";position:absolute;left:0;top:25%;bottom:25%;width:3px;border-radius:2px;background:#005fb8}
#tc-fp .side hr{border:0;border-top:1px solid #e1e1e1;margin:.45em .3em}
#tc-fp svg{width:1.25em;height:1.25em;flex:none}
#tc-fp .list{padding:.3em .6em}
#tc-fp .row{display:grid;grid-template-columns:44% 23% 16% 17%;align-items:center;padding:.38em .5em;border:1px solid transparent;border-radius:4px}
#tc-fp .head{color:#5f5f5f;font-size:.92em;border-bottom:1px solid #ececec;border-radius:0}
#tc-fp .row .n{display:flex;align-items:center;gap:.55em;overflow:hidden;white-space:nowrap;text-overflow:ellipsis}
#tc-fp .row .m,#tc-fp .row .t,#tc-fp .row .s{color:#5f5f5f}
#tc-fp .row .s{text-align:right;padding-right:.6em}
#tc-fp .row.sel{background:#cce8ff;border-color:#99d1ff}
#tc-fp .foot{display:grid;grid-template-columns:auto 1fr 30%;gap:.6em .7em;align-items:center;padding:.8em 1em;border-top:1px solid #e5e5e5}
#tc-fp .field,#tc-fp .filter{background:#fff;border:1px solid #d1d1d1;border-bottom-color:#8a8a8a;border-radius:5px;padding:.38em .65em;min-height:1.35em;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
#tc-fp .filter::after{content:"\\2304";float:right;color:#5c5c5c}
#tc-fp .btns{grid-column:2 / 4;display:flex;justify-content:flex-end;gap:.6em}
#tc-fp .btn{min-width:7.5em;text-align:center;padding:.42em 1em;border-radius:5px;border:1px solid #d1d1d1;background:#fff}
#tc-fp .btn.primary{background:#005fb8;border-color:#005fb8;color:#fff}
`

export interface PickerView {
  folder: string
  files: PickerFile[]
  labels: PickerLabels
  locale: string
}

/** The dialog's markup. Ids the recording acts on: tc-fp-file-<i>, tc-fp-name, tc-fp-open. */
export function pickerHtml(view: PickerView): string {
  const { labels: l, locale } = view
  const folder = escapeHtml(view.folder)
  const nav = (label: string, on = false) =>
    `<div class="${on ? 'on' : ''}">${FOLDER_ICON}<span>${escapeHtml(label)}</span></div>`
  const isDownloads = view.folder.toLowerCase() === 'downloads'
  const rows = view.files
    .map(
      (f, i) =>
        `<div class="row" id="tc-fp-file-${i}"><span class="n">${FILE_ICON}<span>${escapeHtml(f.name)}</span></span>` +
        `<span class="m">${escapeHtml(formatModified(f.modified, locale))}</span>` +
        `<span class="t">${escapeHtml(fileTypeLabel(f.name, l))}</span>` +
        `<span class="s">${escapeHtml(formatSize(f.bytes, locale))}</span></div>`,
    )
    .join('')
  return (
    `<style>${STYLE}</style>` +
    `<div class="win" role="dialog" aria-label="${escapeHtml(l.title)}">` +
    `<div class="title"><span>${escapeHtml(l.title)}</span><span class="x">✕</span></div>` +
    `<div class="nav"><span class="g">←</span><span class="g">→</span><span class="g">↑</span>` +
    `<span class="addr">${FOLDER_ICON}<span class="sep">›</span><span>${escapeHtml(l.thisPc)}</span>` +
    `<span class="sep">›</span><span>${folder}</span></span>` +
    `<span class="g">↻</span><span class="search">${escapeHtml(l.search.replace('{folder}', view.folder))}</span></div>` +
    `<div class="cmd"><span>＋ ${escapeHtml(l.newFolder)}</span></div>` +
    `<div class="body"><div class="side">${nav(l.home)}${nav(l.gallery)}<hr>${nav(l.desktop)}` +
    `${nav(l.downloads, isDownloads)}${nav(l.documents)}${nav(l.pictures)}${nav(l.music)}${nav(l.videos)}` +
    `${isDownloads ? '' : nav(view.folder, true)}<hr>${nav(l.thisPc)}</div>` +
    `<div class="list"><div class="row head"><span>${escapeHtml(l.name)}</span><span>${escapeHtml(l.modified)}</span>` +
    `<span>${escapeHtml(l.type)}</span><span class="s">${escapeHtml(l.size)}</span></div>${rows}</div></div>` +
    `<div class="foot"><span>${escapeHtml(l.fileName)}</span><span class="field" id="tc-fp-name"></span>` +
    `<span class="filter">${escapeHtml(l.allFiles)}</span>` +
    `<div class="btns"><span class="btn primary" id="tc-fp-open">${escapeHtml(l.open)}</span>` +
    `<span class="btn">${escapeHtml(l.cancel)}</span></div></div></div>`
  )
}

export async function openFilePicker(page: Page, view: PickerView): Promise<void> {
  await page.evaluate(html => {
    document.getElementById('tc-fp')?.remove()
    const host = document.createElement('div')
    host.id = 'tc-fp'
    // Safe: pickerHtml escapes every value it did not write itself (file names, folder,
    // labels) - see escapeHtml and the test that feeds it markup.
    host.innerHTML = html
    document.documentElement.appendChild(host)
  }, pickerHtml(view))
}

/** Marks every listed file as chosen and writes the names into the file-name field. */
export async function selectPickerFiles(page: Page): Promise<void> {
  await page.evaluate(() => {
    const rows = Array.from(document.querySelectorAll<HTMLElement>('#tc-fp .row:not(.head)'))
    for (const row of rows) row.classList.add('sel')
    const names = rows.map(r => r.querySelector('.n')?.textContent?.trim() ?? '')
    const field = document.getElementById('tc-fp-name')
    if (field) field.textContent = names.length > 1 ? names.map(n => `"${n}"`).join(' ') : (names[0] ?? '')
  })
}

export async function closeFilePicker(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const host = document.getElementById('tc-fp')
    if (!host) return
    host.classList.add('closing')
    await new Promise(resolve => setTimeout(resolve, 160))
    host.remove()
  })
}
