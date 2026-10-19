// Add Simplified Chinese to every plugin description in market.json.
//
// The index format lets `description` be either a string or a localized map
// such as `{ "en": "...", "zh": "..." }`, and the Discover tab renders the
// entry matching the UI language. The English text is always kept verbatim:
// a machine translation is a reading aid, never the authoritative wording.
//
// Translations are cached in translations.json keyed by the SHA-256 of the
// source text, so a daily refresh pays only for descriptions that are new or
// that actually changed.
//
// Requirements: DEEPSEEK_API_KEY in the environment.
//
//   node translate.mjs
//   BATCH=15 TCONC=4 node translate.mjs

import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const HERE = dirname(fileURLToPath(import.meta.url))
const INDEX = join(HERE, 'market.json')
const CACHE = join(HERE, 'translations.json')

const KEY = process.env.DEEPSEEK_API_KEY
const API = 'https://api.deepseek.com/chat/completions'
const MODEL = process.env.TRANSLATE_MODEL ?? 'deepseek-chat'
const BATCH = Number(process.env.BATCH ?? 15)
const CONCURRENCY = Number(process.env.TCONC ?? 4)

if (!KEY) throw new Error('DEEPSEEK_API_KEY is not set')

const CJK = /[\u3400-\u4dbf\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]/

const SYSTEM = [
  '你是技术文档译者。把用户给的英文插件描述译成简体中文。',
  '规则：',
  '1. 产品名、包名、命令、协议名、文件名、URL、版本号保留英文原文；',
  '2. 不要添加原文没有的信息，不要评价，不要补全缩写；',
  '3. 每条译文不超过原文长度的 1.6 倍；',
  '4. 输出必须是 JSON 字符串数组，长度与输入数组完全相同，顺序一致；',
  '5. 只输出 JSON，不要代码块标记，不要任何解释。',
].join('\n')

const sha = text => createHash('sha256').update(text).digest('hex')
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

async function translateBatch(texts) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const response = await fetch(API, {
        method: 'POST',
        headers: { authorization: `Bearer ${KEY}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          model: MODEL,
          temperature: 0.2,
          messages: [
            { role: 'system', content: SYSTEM },
            { role: 'user', content: JSON.stringify(texts) },
          ],
        }),
      })
      if (!response.ok) throw new Error(`HTTP ${String(response.status)}: ${(await response.text()).slice(0, 200)}`)
      const body = await response.json()
      const raw = body.choices?.[0]?.message?.content ?? ''
      const cleaned = raw.replace(/^\s*```(?:json)?/i, '').replace(/```\s*$/, '').trim()
      const parsed = JSON.parse(cleaned)
      if (!Array.isArray(parsed) || parsed.length !== texts.length) {
        throw new Error(`expected ${String(texts.length)} items, got ${String(Array.isArray(parsed) ? parsed.length : typeof parsed)}`)
      }
      return parsed.map(value => (typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined))
    } catch (error) {
      if (attempt === 3) throw error
      await sleep(600 * attempt)
    }
  }
  return []
}

/** Translate a list of texts, falling back to one-by-one for stubborn batches. */
async function translateAll(texts) {
  const results = new Map()
  let cursor = 0
  let done = 0

  const worker = async () => {
    for (;;) {
      const start = cursor
      cursor += BATCH
      if (start >= texts.length) return
      const slice = texts.slice(start, start + BATCH)
      let out
      try {
        out = await translateBatch(slice)
      } catch {
        out = []
      }
      if (out.length !== slice.length) {
        out = []
        for (const single of slice) {
          try {
            const [translated] = await translateBatch([single])
            out.push(translated)
          } catch {
            out.push(undefined)
          }
        }
      }
      slice.forEach((text, index) => {
        if (out[index]) results.set(text, out[index])
      })
      done += slice.length
      if (done % 150 === 0 || done >= texts.length) {
        process.stderr.write(`translated: ${String(done)} / ${String(texts.length)}\n`)
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, Math.ceil(texts.length / BATCH)) }, worker))
  return results
}

const index = JSON.parse(readFileSync(INDEX, 'utf8'))
const cache = existsSync(CACHE) ? JSON.parse(readFileSync(CACHE, 'utf8')) : {}

const englishOf = plugin => {
  const value = plugin.description
  if (typeof value === 'string') return value
  if (value && typeof value === 'object' && typeof value.en === 'string') return value.en
  return undefined
}

const wanted = new Set()
for (const plugin of index.plugins) {
  const english = englishOf(plugin)
  if (english === undefined || CJK.test(english)) continue
  if (cache[sha(english)]) continue
  wanted.add(english)
}

process.stderr.write(`cache: ${String(Object.keys(cache).length)} entries; to translate: ${String(wanted.size)}\n`)

if (wanted.size > 0) {
  const pending = [...wanted]
  const translated = await translateAll(pending)
  let added = 0
  for (const [text, chinese] of translated) {
    cache[sha(text)] = chinese
    added++
  }
  writeFileSync(CACHE, `${JSON.stringify(cache, Object.keys(cache).sort(), 1)}\n`)
  process.stderr.write(`new translations: ${String(added)}\n`)
}

let localized = 0
let untouched = 0
for (const plugin of index.plugins) {
  const english = englishOf(plugin)
  if (english === undefined) continue
  if (CJK.test(english)) { untouched++; continue }
  const chinese = cache[sha(english)]
  if (!chinese) { untouched++; continue }
  plugin.description = { en: english, zh: chinese }
  localized++
}

index.description = {
  en: 'Every npm package tagged dsh-plugin, generated from registry metadata. Each version carries engines.dsh so the Discover tab shows which versions fit your runtime.',
  zh: 'npm 上所有带 dsh-plugin 标签的包，由 registry 元数据生成。每个版本都带 engines.dsh，Discover 页据此标出哪些版本适配你当前的运行时。描述的中文为机器翻译，仅供阅读参考，以 en 原文为准。',
}

writeFileSync(INDEX, `${JSON.stringify(index, undefined, 1)}\n`)
process.stderr.write(`localized: ${String(localized)}  left as-is: ${String(untouched)}\n`)
