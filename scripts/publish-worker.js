#!/usr/bin/env node
/**
 * Publish the current commit for worker PCs.
 * They download it the next time fill-ds160 opens.
 *
 *   npm run publish-worker
 */
import { spawnSync } from 'node:child_process'

function git(args) {
  return spawnSync('git', args, { encoding: 'utf8' })
}

const status = git(['status', '--porcelain', '--untracked-files=no'])
if (status.status !== 0) {
  console.error((status.stderr || 'git status failed').trim())
  process.exit(status.status || 1)
}
if (status.stdout.trim()) {
  console.error('Commit your changes first. publish-worker sends the latest commit, not uncommitted edits.')
  process.exit(1)
}

const push = git(['push', 'origin', 'HEAD:worker'])
if (push.stdout) process.stdout.write(push.stdout)
if (push.stderr) process.stderr.write(push.stderr)
if (push.status !== 0) process.exit(push.status || 1)

const sha = git(['rev-parse', '--short', 'HEAD']).stdout.trim()
console.log(`Published ${sha} to worker. Workers get it the next time they open fill-ds160.`)
