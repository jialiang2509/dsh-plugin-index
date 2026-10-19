// One-off repair: drop any engines.dsh that is not a real SemVer range.
//
// The market's parser rejects the whole document when a single range is
// malformed, so an unusable derived range must be removed rather than shipped.

import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import semver from 'semver'

const HERE = dirname(fileURLToPath(import.meta.url))
const file = join(HERE, 'market.json')
const index = JSON.parse(readFileSync(file, 'utf8'))

let dropped = 0
let kept = 0
for (const plugin of index.plugins) {
  for (const version of plugin.versions) {
    const range = version.engines?.dsh
    if (range === undefined) continue
    if (semver.validRange(range) === null) {
      delete version.engines
      dropped++
      continue
    }
    const normalized = semver.validRange(range)
    if (normalized !== range) {
      // Keep the author's text byte-identical; only reject what cannot parse.
      kept++
    } else {
      kept++
    }
  }
  // Recompute the label from what survived.
  const declared = plugin.metadata?.labels?.includes('engines-declared')
  const hasRange = plugin.versions.some(version => version.engines)
  const label = declared && hasRange ? 'engines-declared' : hasRange ? 'engines-derived' : 'engines-absent'
  plugin.metadata = { labels: [label] }
}

writeFileSync(file, `${JSON.stringify(index, undefined, 1)}\n`)
console.log(`kept ${String(kept)} ranges, dropped ${String(dropped)} unparsable`)
