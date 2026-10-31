import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import {
  applyExtractedTree,
  isPreservedRel,
  kitShaPath,
  updateFillKit,
} from '../scripts/update-fill-kit.js'

const SHA = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
const NEXT = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'

function tempRepo() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'fill-kit-test-'))
}

test('preserved paths stay on the worker machine', () => {
  assert.equal(isPreservedRel('.env'), true)
  assert.equal(isPreservedRel('.env.local'), true)
  assert.equal(isPreservedRel(path.join('node_modules', 'playwright')), true)
  assert.equal(isPreservedRel(path.join('autofill-output', 'fill-queue.json')), true)
  assert.equal(isPreservedRel(path.join('people', 'a.txt')), true)
  assert.equal(isPreservedRel(path.join('autofill', 'agent.js')), false)
})

test('applyExtractedTree replaces source and keeps local secrets and output', () => {
  const dest = tempRepo()
  const source = tempRepo()
  fs.mkdirSync(path.join(dest, 'autofill'), { recursive: true })
  fs.mkdirSync(path.join(dest, 'node_modules'), { recursive: true })
  fs.mkdirSync(path.join(dest, 'autofill-output'), { recursive: true })
  fs.mkdirSync(path.join(dest, 'people'), { recursive: true })
  fs.mkdirSync(path.join(dest, 'old'), { recursive: true })
  fs.writeFileSync(path.join(dest, '.env'), 'SECRET=1\n')
  fs.writeFileSync(path.join(dest, 'node_modules', 'keep.js'), 'keep\n')
  fs.writeFileSync(path.join(dest, 'autofill-output', 'fill-queue.json'), '{"q":1}\n')
  fs.writeFileSync(path.join(dest, 'people', 'local.txt'), 'local\n')
  fs.writeFileSync(path.join(dest, 'autofill', 'agent.js'), 'old\n')
  fs.writeFileSync(path.join(dest, 'old', 'stale.js'), 'stale\n')
  fs.writeFileSync(path.join(dest, 'package-lock.json'), 'lock-old\n')

  fs.mkdirSync(path.join(source, 'autofill'), { recursive: true })
  fs.writeFileSync(path.join(source, 'package.json'), '{"name":"kit"}\n')
  fs.writeFileSync(path.join(source, 'autofill', 'agent.js'), 'new\n')
  fs.writeFileSync(path.join(source, 'package-lock.json'), 'lock-new\n')
  fs.writeFileSync(path.join(source, '.env'), 'FROM-ARCHIVE=1\n')

  applyExtractedTree(dest, source)

  assert.equal(fs.readFileSync(path.join(dest, '.env'), 'utf8'), 'SECRET=1\n')
  assert.equal(fs.readFileSync(path.join(dest, 'node_modules', 'keep.js'), 'utf8'), 'keep\n')
  assert.equal(fs.readFileSync(path.join(dest, 'autofill-output', 'fill-queue.json'), 'utf8'), '{"q":1}\n')
  assert.equal(fs.readFileSync(path.join(dest, 'people', 'local.txt'), 'utf8'), 'local\n')
  assert.equal(fs.readFileSync(path.join(dest, 'autofill', 'agent.js'), 'utf8'), 'new\n')
  assert.equal(fs.readFileSync(path.join(dest, 'package-lock.json'), 'utf8'), 'lock-new\n')
  assert.equal(fs.existsSync(path.join(dest, 'old', 'stale.js')), false)
  fs.rmSync(dest, { recursive: true, force: true })
  fs.rmSync(source, { recursive: true, force: true })
})

test('a git checkout is not updated', async () => {
  const repo = tempRepo()
  fs.mkdirSync(path.join(repo, '.git'))
  let called = false
  const result = await updateFillKit({
    repoRoot: repo,
    token: 'token',
    log() {},
    warn() {},
    materialize() {
      called = true
    },
  })
  assert.deepEqual(result, { restart: false, busy: false })
  assert.equal(called, false)
  fs.rmSync(repo, { recursive: true, force: true })
})

test('matching sha does not download', async () => {
  const repo = tempRepo()
  fs.mkdirSync(path.join(repo, 'autofill-output'), { recursive: true })
  fs.writeFileSync(kitShaPath(repo), `${SHA}\n`)
  let materialized = false
  const result = await updateFillKit({
    repoRoot: repo,
    token: 'token',
    log() {},
    warn() {},
    fetchImpl: async () => ({ ok: true, json: async () => ({ sha: SHA }) }),
    materialize() {
      materialized = true
    },
  })
  assert.equal(result.restart, false)
  assert.equal(materialized, false)
  fs.rmSync(repo, { recursive: true, force: true })
})

test('a newer commit is applied and npm install runs when the lockfile changes', async () => {
  const repo = tempRepo()
  const source = tempRepo()
  fs.writeFileSync(path.join(repo, 'package.json'), '{"name":"old"}\n')
  fs.writeFileSync(path.join(repo, 'package-lock.json'), 'old-lock\n')
  fs.writeFileSync(path.join(repo, 'stale.js'), 'gone\n')
  fs.mkdirSync(path.join(source, 'autofill'), { recursive: true })
  fs.writeFileSync(path.join(source, 'package.json'), '{"name":"new"}\n')
  fs.writeFileSync(path.join(source, 'package-lock.json'), 'new-lock\n')
  fs.writeFileSync(path.join(source, 'autofill', 'agent.js'), 'new\n')

  let installed = 0
  const result = await updateFillKit({
    repoRoot: repo,
    token: 'token',
    log() {},
    warn() {},
    fetchImpl: async () => ({ ok: true, json: async () => ({ sha: NEXT }) }),
    materialize: async () => source,
    runInstall() {
      installed += 1
    },
  })

  assert.equal(result.restart, true)
  assert.equal(installed, 1)
  assert.equal(fs.readFileSync(path.join(repo, 'autofill', 'agent.js'), 'utf8'), 'new\n')
  assert.equal(fs.existsSync(path.join(repo, 'stale.js')), false)
  assert.equal(fs.readFileSync(kitShaPath(repo), 'utf8').trim(), NEXT)
  assert.equal(fs.existsSync(path.join(repo, 'autofill-output', '.fill-kit-update.lock')), false)
  fs.rmSync(repo, { recursive: true, force: true })
  fs.rmSync(source, { recursive: true, force: true })
})

test('npm install is skipped when the lockfile is unchanged', async () => {
  const repo = tempRepo()
  const source = tempRepo()
  fs.writeFileSync(path.join(repo, 'package.json'), '{"name":"kit"}\n')
  fs.writeFileSync(path.join(repo, 'package-lock.json'), 'same-lock\n')
  fs.writeFileSync(path.join(source, 'package.json'), '{"name":"kit"}\n')
  fs.writeFileSync(path.join(source, 'package-lock.json'), 'same-lock\n')
  fs.writeFileSync(path.join(source, 'autofill.js'), 'new\n')
  let installed = 0
  const result = await updateFillKit({
    repoRoot: repo,
    token: 'token',
    log() {},
    warn() {},
    fetchImpl: async () => ({ ok: true, json: async () => ({ sha: NEXT }) }),
    materialize: async () => source,
    runInstall() {
      installed += 1
    },
  })
  assert.equal(result.restart, true)
  assert.equal(installed, 0)
  assert.equal(fs.readFileSync(path.join(repo, 'autofill.js'), 'utf8'), 'new\n')
  fs.rmSync(repo, { recursive: true, force: true })
  fs.rmSync(source, { recursive: true, force: true })
})

test('github failures leave the current code in place', async () => {
  const repo = tempRepo()
  fs.writeFileSync(path.join(repo, 'keep.js'), 'keep\n')
  const warnings = []
  const result = await updateFillKit({
    repoRoot: repo,
    token: 'token',
    log() {},
    warn(message) {
      warnings.push(message)
    },
    fetchImpl: async () => {
      throw new Error('network down')
    },
  })
  assert.equal(result.restart, false)
  assert.equal(fs.readFileSync(path.join(repo, 'keep.js'), 'utf8'), 'keep\n')
  assert.match(warnings.join('\n'), /network down/)
  fs.rmSync(repo, { recursive: true, force: true })
})
