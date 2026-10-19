// Build a DeepSeek Harness plugin market index (format 1) from the npm registry.
//
// Usage:
//   node generate.mjs            # default caps
//   TIER1=800 MAX_TOTAL=9000 node generate.mjs
//
// Tier 1 packages get their full version history (and therefore per-version
// `engines.dsh`, which is how DSH itself decides whether a version fits the
// running runtime). Tier 2 packages get their latest version only.
//
// Output: market.json next to this script.

import { writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import semver from 'semver'

const HERE = dirname(fileURLToPath(import.meta.url))
const SEARCH = 'https://registry.npmjs.org/-/v1/search'
const REGISTRY = 'https://registry.npmjs.org'
const KEYWORD = 'dsh-plugin'

const TIER1 = Number(process.env.TIER1 ?? 300)
const MAX_TOTAL = Number(process.env.MAX_TOTAL ?? 3000)
const MAX_VERSIONS = Number(process.env.MAX_VERSIONS ?? 40)
const CONCURRENCY = Number(process.env.CONCURRENCY ?? 10)
const PAGE = 250

const SEMVER = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/
const PACKAGE_NAME = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/

async function getJson(url, accept) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const response = await fetch(url, accept ? { headers: { accept } } : {})
      if (response.status === 404) return undefined
      if (!response.ok) throw new Error(`HTTP ${String(response.status)}`)
      return await response.json()
    } catch (error) {
      if (attempt === 3) throw error
      await new Promise(resolve => setTimeout(resolve, 400 * attempt))
    }
  }
}

/** Run tasks with bounded concurrency, preserving input order. */
async function mapLimit(items, limit, run) {
  const results = new Array(items.length)
  let cursor = 0
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const index = cursor++
      if (index >= items.length) return
      results[index] = await run(items[index], index)
    }
  })
  await Promise.all(workers)
  return results
}

function httpUrlOrUndefined(value, { allowQuery = false } = {}) {
  if (typeof value !== 'string' || value.trim() === '') return undefined
  let url
  try { url = new URL(value) } catch { return undefined }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return undefined
  if (url.username || url.password) return undefined
  if (!allowQuery && (url.href.includes('?') || url.href.includes('#'))) return undefined
  return url.href
}

function repositoryOf(raw) {
  if (typeof raw !== 'string' || raw.trim() === '') return undefined
  let text = raw.trim()
  const shorthand = /^(?:github|gitlab|bitbucket):(.+)$/.exec(text)
  if (shorthand) {
    const parts = shorthand[1].replace(/\.git$/, '').split('/')
    if (parts.length < 2) return undefined
    const host = text.slice(0, text.indexOf(':'))
    return { url: `https://${host}.com/${parts[0]}/${parts[1]}` }
  }
  text = text.replace(/^git\+/, '')
  if (text.startsWith('git://')) text = `https://${text.slice('git://'.length)}`
  text = text.replace(/\.git$/, '')
  const url = httpUrlOrUndefined(text)
  return url === undefined ? undefined : { url }
}

function validRange(value) {
  if (typeof value !== 'string' || value.trim() === '' || value.length > 200) return false
  if (value.startsWith('workspace:')) return false
  // The market's parser rejects the entire document for one malformed range,
  // so only expressions semver itself accepts may be emitted.
  return semver.validRange(value) !== null
}

/**
 * Derive a DSH range from the package's own peer requirements.
 *
 * The market decides compatibility from `engines.dsh` alone. Most community
 * plugins never declare it, but they do pin `@deepseek-ai/dsh-*` peers, and
 * those packages ship in lockstep with the dsh runtime (dsh-tools 0.2.1-rc.2
 * belongs to dsh 0.2.1-rc.2). Joining those ranges with spaces is SemVer AND,
 * so the result is the range of runtimes that satisfies every core peer.
 *
 * `@deepseek-ai/cordis` is deliberately excluded: its version line is 4.x and
 * says nothing about the dsh runtime. Ranges using `||` are skipped, because
 * mixing a union into an AND expression changes its meaning.
 */
function derivedRange(manifest) {
  const peers = manifest?.peerDependencies
  if (!peers || typeof peers !== 'object') return undefined
  const ranges = [...new Set(
    Object.entries(peers)
      .filter(([name, range]) => name.startsWith('@deepseek-ai/dsh-') && validRange(range) && !range.includes('||'))
      .map(([, range]) => range.trim()),
  )]
  if (ranges.length === 0) return undefined
  const joined = ranges.join(' ')
  return joined.length <= 200 ? joined : undefined
}

function versionEntry(version, publishTimestamp, manifest) {
  if (!SEMVER.test(version)) return undefined
  if (!Number.isInteger(publishTimestamp) || publishTimestamp <= 0 || publishTimestamp >= 1e11) return undefined
  const entry = { version, publishTimestamp, source: { type: 'npm' } }
  const declared = manifest?.engines?.dsh
  const range = validRange(declared) ? declared : derivedRange(manifest)
  if (range) entry.engines = { dsh: range }
  return entry
}

/** Full registry document -> every version with its publish time. */
function versionsFromDocument(doc) {
  const times = doc.time && typeof doc.time === 'object' ? doc.time : {}
  const entries = []
  for (const [version, manifest] of Object.entries(doc.versions ?? {})) {
    if (version === 'created' || version === 'modified') continue
    const stamp = Date.parse(times[version])
    if (Number.isNaN(stamp)) continue
    const entry = versionEntry(version, Math.floor(stamp / 1000), manifest)
    if (entry) entries.push(entry)
  }
  entries.sort((left, right) => compareVersions(right.version, left.version))
  return entries.slice(0, MAX_VERSIONS)
}

/** The abbreviated manifest is enough for peers and engines of one version. */
async function latestManifest(name) {
  const doc = await getJson(`${REGISTRY}/${name.replace('/', '%2F')}`, 'application/vnd.npm.install-v1+json')
  const tag = doc?.['dist-tags']?.latest
  return tag ? doc?.versions?.[tag] : undefined
}

function compareVersions(left, right) {
  const split = value => value.split('-')[0].split('.').map(Number)
  const [a, b] = [split(left), split(right)]
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] - b[i]
  return left.localeCompare(right)
}

async function collectPackages() {
  const found = new Map()
  let from = 0
  let total = Infinity
  while (found.size < MAX_TOTAL && from < total) {
    const page = await getJson(`${SEARCH}?text=keywords%3A${KEYWORD}&size=${PAGE}&from=${from}`)
    if (!page?.objects?.length) break
    total = page.total ?? Infinity
    for (const object of page.objects) {
      const pkg = object.package
      if (!pkg?.name || found.has(pkg.name)) continue
      found.set(pkg.name, {
        name: pkg.name,
        latest: pkg.version,
        date: Date.parse(pkg.date ?? ''),
        description: pkg.description,
        author: typeof pkg.publisher?.username === 'string' ? pkg.publisher.username : undefined,
        homepage: pkg.links?.homepage,
        repository: pkg.links?.repository ?? pkg.repository,
        downloads: object.downloads?.monthly ?? 0,
      })
      if (found.size >= MAX_TOTAL) break
    }
    process.stderr.write(`search: ${String(found.size)} / ${String(Math.min(total, MAX_TOTAL))}\n`)
    from += PAGE
  }
  return [...found.values()]
}

async function build() {
  const packages = await collectPackages()
  const ranked = [...packages].sort((left, right) => right.downloads - left.downloads)
  const tier1 = new Set(ranked.slice(0, TIER1).map(pkg => pkg.name))

  let done = 0
  const plugins = await mapLimit(ranked, CONCURRENCY, async pkg => {
    let versions = []
    let declared = false
    if (tier1.has(pkg.name)) {
      const doc = await getJson(`${REGISTRY}/${pkg.name.replace('/', '%2F')}`).catch(() => undefined)
      if (doc) {
        versions = versionsFromDocument(doc)
        declared = Object.values(doc.versions ?? {}).some(manifest => validRange(manifest?.engines?.dsh))
      }
    }
    if (versions.length === 0) {
      const stamp = Number.isFinite(pkg.date) ? Math.floor(pkg.date / 1000) : undefined
      const manifest = await latestManifest(pkg.name).catch(() => undefined)
      declared = validRange(manifest?.engines?.dsh)
      const entry = versionEntry(pkg.latest, stamp, manifest)
      if (entry) versions = [entry]
    }
    done++
    if (done % 100 === 0) process.stderr.write(`detail: ${String(done)} / ${String(ranked.length)}\n`)
    if (versions.length === 0) return undefined

    const plugin = { name: pkg.name }
    if (typeof pkg.description === 'string' && pkg.description.trim() !== '') plugin.description = pkg.description.trim().slice(0, 400)
    if (pkg.author) plugin.author = pkg.author
    const homepage = httpUrlOrUndefined(pkg.homepage, { allowQuery: true })
    if (homepage) plugin.homepage = homepage
    const repository = repositoryOf(pkg.repository)
    if (repository) plugin.repository = repository
    plugin.versions = versions
    plugin.__declared = declared
    return plugin
  })

  const valid = plugins.filter(plugin => plugin && PACKAGE_NAME.test(plugin.name) && plugin.versions.length > 0)

  // "declared" when the author shipped engines.dsh; "derived" when we inferred it
  // from core peer ranges; "none" when the package carries no usable signal.
  const kindOf = plugin => {
    if (!plugin) return 'none'
    if (plugin.__declared) return 'declared'
    return plugin.versions.some(version => version.engines) ? 'derived' : 'none'
  }
  const withRange = valid.filter(plugin => plugin.versions.some(version => version.engines)).length

  const index = {
    format: 1,
    title: 'DSH Plugin Index',
    description: [
      `Every npm package tagged ${KEYWORD}, generated from registry metadata.`,
      'Each version carries engines.dsh so the Discover tab shows which versions fit your runtime.',
      'engines.dsh is taken from the package when the author declares it, and otherwise derived from the',
      'package\'s own @deepseek-ai/dsh-* peerDependencies (those ship in lockstep with the runtime).',
      'Derived ranges are marked by the "Derived DSH range" label; treat them as a pointer, not a promise.',
    ].join(' '),
    metadata: {
      labels: {
        'engines-declared': { title: { en: 'Declares DSH range', zh: '作者声明了 DSH 范围' } },
        'engines-derived': { title: { en: 'Derived DSH range', zh: '推导的 DSH 范围' } },
        'engines-absent': { title: { en: 'No DSH range', zh: '无 DSH 范围信息' } },
      },
    },
    plugins: valid.map(plugin => {
      const kind = kindOf(plugin)
      const { __declared, ...clean } = plugin
      return {
        ...clean,
        metadata: {
          labels: [kind === 'declared' ? 'engines-declared' : kind === 'derived' ? 'engines-derived' : 'engines-absent'],
        },
      }
    }),
  }

  const out = join(HERE, 'market.json')
  writeFileSync(out, `${JSON.stringify(index, undefined, 1)}\n`)
  process.stderr.write(`\nplugins: ${String(valid.length)} (with any engines.dsh: ${String(withRange)})\n`)
  process.stderr.write(`versions: ${String(valid.reduce((sum, plugin) => sum + plugin.versions.length, 0))}\n`)
  process.stderr.write(`wrote ${out}\n`)
}

await build()
