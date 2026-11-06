import assert from 'node:assert/strict'
import test from 'node:test'
import {
  DEFAULT_PICKER_LABELS,
  fileTypeLabel,
  formatSize,
  pickerHtml,
  pickerLabels,
  type PickerFile,
} from './file-picker.js'

const gif: PickerFile = { name: 'team_animated.gif', bytes: 1_528_832, modified: new Date(2026, 10, 5, 22, 23) }

test('labels default to English and take only known, non-empty overrides', () => {
  assert.deepEqual(pickerLabels(undefined), DEFAULT_PICKER_LABELS)
  const l = pickerLabels({ open: 'Ouvrir', cancel: '', bogus: 'x' })
  assert.equal(l.open, 'Ouvrir')
  assert.equal(l.cancel, 'Cancel')
  assert.equal((l as unknown as Record<string, string>).bogus, undefined)
})

test('size is whole kilobytes rounded up, in the locale', () => {
  assert.equal(formatSize(1_528_832, 'en-US'), '1,493 KB')
  assert.equal(formatSize(1_528_832, 'de-DE'), '1.493 KB')
  assert.equal(formatSize(10, 'en-US'), '1 KB')
})

test('file type comes from the extension', () => {
  assert.equal(fileTypeLabel('a.gif', DEFAULT_PICKER_LABELS), 'GIF File')
  assert.equal(fileTypeLabel('a.mp4', pickerLabels({ fileType: '{ext}-Datei' })), 'MP4-Datei')
})

test('the dialog shows the folder and the chosen files only, escaped, with the ids the recording uses', () => {
  const html = pickerHtml({
    folder: 'Downloads',
    files: [gif, { ...gif, name: '<b>x</b>.png' }],
    labels: DEFAULT_PICKER_LABELS,
    locale: 'en-US',
  })
  assert.match(html, /role="dialog"/)
  assert.match(html, /id="tc-fp-file-0"[^]*team_animated\.gif/)
  assert.match(html, /id="tc-fp-file-1"/)
  assert.doesNotMatch(html, /id="tc-fp-file-2"/)
  assert.match(html, /id="tc-fp-open"/)
  assert.match(html, /id="tc-fp-name"/)
  assert.match(html, /&lt;b&gt;x&lt;\/b&gt;\.png/)
  assert.doesNotMatch(html, /<b>x<\/b>/)
  assert.match(html, /Search Downloads/)
})
