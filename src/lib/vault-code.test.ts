import assert from 'node:assert/strict'
import test from 'node:test'
import { codeFromVault, pickTotpEntry, type VaultClient, type VaultEntry, type VaultRelease } from './vault-code.js'

const jpresting: VaultEntry = {
  name: 'www.instagram.com (jpresting)',
  account: 'jpresting',
  sites: ['www.instagram.com'],
  kinds: ['password', 'username', 'totp'],
}
const other: VaultEntry = { ...jpresting, name: 'www.instagram.com (markenbuilder)', account: 'markenbuilder' }
const noKey: VaultEntry = { ...jpresting, kinds: ['password', 'username'] }

const fake = (entries: VaultEntry[], answers: VaultRelease[]): VaultClient & { asked: number } => {
  const client = {
    asked: 0,
    entries: async () => entries,
    release: async () => answers[Math.min(client.asked++, answers.length - 1)]!,
  }
  return client
}
const args = { host: 'www.instagram.com', account: 'JPresting', origin: 'https://www.instagram.com', reason: 'test' }

test('the entry is found by site and account, whatever the case', () => {
  const picked = pickTotpEntry([other, jpresting], 'www.instagram.com', 'JPresting')
  assert.deepEqual(picked, { entry: jpresting })
})

test('an entry on a parent or sub domain of the site counts', () => {
  const parent = { ...jpresting, sites: ['instagram.com'] }
  assert.deepEqual(pickTotpEntry([parent], 'www.instagram.com', 'jpresting'), { entry: parent })
})

test('no entry for the account says where to save the login', () => {
  const r = pickTotpEntry([other], 'www.instagram.com', 'jpresting')
  assert.ok('error' in r && /no entry for jpresting/.test(r.error))
})

test('an entry without an authenticator key says how to add it', () => {
  const r = pickTotpEntry([noKey], 'www.instagram.com', 'jpresting')
  assert.ok('error' in r && /holds no authenticator key yet/.test(r.error) && /Authenticator key \(TOTP\)/.test(r.error))
})

test('two entries with a key are not guessed between', () => {
  const r = pickTotpEntry([jpresting, { ...jpresting, name: 'second' }], 'www.instagram.com', 'jpresting')
  assert.ok('error' in r && /keep only one/.test(r.error))
})

test('a released code is returned', async () => {
  assert.equal(await codeFromVault(args, fake([jpresting], [{ status: 'released', value: '123456' }])), '123456')
})

test('a code waiting for the Allow is asked for again until it comes', async () => {
  const client = fake([jpresting], [{ status: 'pending' }, { status: 'pending' }, { status: 'released', value: '654321' }])
  assert.equal(await codeFromVault(args, client), '654321')
  assert.equal(client.asked, 3)
})

test('an Allow nobody presses ends in a plain sentence after a bounded number of asks', async () => {
  const client = fake([jpresting], [{ status: 'pending' }])
  await assert.rejects(codeFromVault(args, client), /waits for the Allow on Telegram/)
  assert.equal(client.asked, 6)
})

test('a refusal names the reason and does not retry', async () => {
  const client = fake([jpresting], [{ status: 'denied', message: 'The owner denied this sign-in.' }])
  await assert.rejects(codeFromVault(args, client), /\(denied\): The owner denied/)
  assert.equal(client.asked, 1)
})

test('something that is not a code is refused', async () => {
  await assert.rejects(codeFromVault(args, fake([jpresting], [{ status: 'released', value: 'hunter2' }])), /not a code/)
})

test('an unreachable vault is said so', async () => {
  const client: VaultClient = {
    entries: async () => {
      throw new Error('this computer is not joined to an AWG hub')
    },
    release: async () => ({ status: 'off' }),
  }
  await assert.rejects(codeFromVault(args, client), /could not be reached: this computer is not joined/)
})
