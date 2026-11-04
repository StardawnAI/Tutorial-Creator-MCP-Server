import assert from 'node:assert/strict'
import test from 'node:test'
import { decide, MIN_GAP_MS, RUNNING_MS, type GuardInput } from './login-guard.js'

const NOW = Date.parse('2026-11-04T15:00:00Z')
const ago = (ms: number): string => new Date(NOW - ms).toISOString()
const base: GuardInput = { now: NOW, last: undefined, secretAt: 0, real: false, approved: false, account: 'instagram account jpresting' }

test('a first sign-in of a test account goes ahead', () => {
  assert.deepEqual(decide(base), { ok: true })
})

test('a real account waits for the person, then goes ahead', () => {
  const held = decide({ ...base, real: true })
  assert.equal(held.ok, false)
  assert.equal(!held.ok && held.code, 'needs-person')
  assert.deepEqual(decide({ ...base, real: true, approved: true }), { ok: true })
})

test('a rejected password is not tried again with the same password', () => {
  const v = decide({ ...base, last: { at: ago(60 * 60_000), result: 'failed' }, secretAt: NOW - 2 * 60 * 60_000 })
  assert.equal(!v.ok && v.code, 'blocked-after-failure')
})

test('a security check nobody finished blocks the next run too', () => {
  const v = decide({ ...base, last: { at: ago(5 * 60_000), result: 'checkpoint' } })
  assert.equal(!v.ok && v.code, 'blocked-after-failure')
})

test('the block lifts by itself when the password was changed after the attempt', () => {
  const v = decide({ ...base, last: { at: ago(60 * 60_000), result: 'failed' }, secretAt: NOW - 10 * 60_000 })
  assert.deepEqual(v, { ok: true })
})

test('a second sign-in while one is running is refused, a crashed one is not', () => {
  const running = decide({ ...base, last: { at: ago(2 * 60_000), result: 'started' } })
  assert.equal(!running.ok && running.code, 'already-running')
  const crashed = decide({ ...base, last: { at: ago(RUNNING_MS + 60_000), result: 'started' } })
  assert.equal(!crashed.ok && crashed.code, 'too-soon')
})

test('a fresh login right after a good one is refused, a later one is not', () => {
  const soon = decide({ ...base, last: { at: ago(10 * 60_000), result: 'signed-in' } })
  assert.equal(!soon.ok && soon.code, 'too-soon')
  assert.deepEqual(decide({ ...base, last: { at: ago(MIN_GAP_MS + 60_000), result: 'signed-in' } }), { ok: true })
})

test('the real-account check comes before everything else', () => {
  const v = decide({ ...base, real: true, last: { at: ago(60_000), result: 'failed' } })
  assert.equal(!v.ok && v.code, 'needs-person')
})
