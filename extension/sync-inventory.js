import { readFileSync, writeFileSync } from 'node:fs'

const src = readFileSync(new URL('../autofill/collect-page-inventory.js', import.meta.url), 'utf8')
const classic = src
  .replace(/^export const /gm, 'var ')
  .replace(/^export function /gm, 'function ')
writeFileSync(new URL('./collect-page-inventory.js', import.meta.url), classic)
