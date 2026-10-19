// Fail the build unless market.json is a valid format-1 index.
//
// Uses the parser DSH itself uses, so a green check here means the Discover tab
// will accept the document rather than reject it at add-source time.

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { parseMarketIndex } from '@deepseek-ai/dsh-plugin-market-index'

const HERE = dirname(fileURLToPath(import.meta.url))
const INDEX_URL = 'https://raw.githubusercontent.com/jialiang2509/dsh-plugin-index/main/market.json'

const index = parseMarketIndex(JSON.parse(readFileSync(join(HERE, 'market.json'), 'utf8')), INDEX_URL)

const versions = index.plugins.reduce((sum, plugin) => sum + plugin.versions.length, 0)
const declared = index.plugins.filter(plugin => plugin.metadata.labels.includes('engines-declared')).length
const derived = index.plugins.filter(plugin => plugin.metadata.labels.includes('engines-derived')).length
const absent = index.plugins.length - declared - derived

console.log(`valid format-1 index: ${index.title}`)
console.log(`plugins:  ${String(index.plugins.length)}`)
console.log(`versions: ${String(versions)}`)
console.log(`engines.dsh declared=${String(declared)} derived=${String(derived)} absent=${String(absent)}`)
