#!/usr/bin/env node
/**
 * CLI fill launcher. Prefer the fill-ds160 Desktop app (small UI, batch).
 *
 *   node scripts/fill-ds160-easy.js
 *   node scripts/fill-ds160-easy.js /path/to/nira_biton.txt [more.txt ...]
 */
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { startFill } from './run-fill.js'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const uiServer = path.join(repoRoot, 'scripts', 'fill-ui', 'server.js')

async function fillFiles(files) {
  for (const file of files) {
    const inputFile = path.resolve(file)
    if (!fs.existsSync(inputFile)) {
      console.error(`File not found: ${inputFile}`)
      process.exit(1)
    }
    console.log(`Filling ${inputFile}`)
    const job = startFill(inputFile, {
      onChunk(text) {
        process.stdout.write(text)
      },
    })
    const result = await job.done
    if (result.code !== 0) process.exit(result.code)
  }
}

function openUi() {
  const child = spawn(process.execPath, [uiServer, '--open'], {
    cwd: repoRoot,
    stdio: 'inherit',
  })
  child.on('exit', (code) => process.exit(code ?? 1))
}

const files = process.argv.slice(2).map((value) => value.trim()).filter(Boolean)
if (files.length) {
  fillFiles(files).catch((err) => {
    console.error(err.message || err)
    process.exit(1)
  })
} else {
  openUi()
}
