# DSH Plugin Index

A [format-1](https://github.com/deepseek-ai/deepseek-harness) plugin market index
for DeepSeek Harness, generated from npm registry metadata.

Add it in DSH: **Plugins → Discover → Add index source**, then paste one of:

```
https://jialiang2509.github.io/dsh-plugin-index/market.json
https://raw.githubusercontent.com/jialiang2509/dsh-plugin-index/main/market.json
```

The Pages URL is served by GitHub's CDN; the `raw.githubusercontent.com` one
bypasses the Pages build and updates the moment a commit lands. Both point at
the same document.

## What it indexes

Every npm package published with the `dsh-plugin` keyword that the npm search
API will page out — **5,250 packages, 21,024 versions** as of 2026-10-19. Each
entry carries:

- the package description, author, homepage, and repository
- up to 25 recent versions with their real publish timestamps
- a per-version `engines.dsh` range, which is the only field DSH uses to decide
  whether a version fits your runtime

npm reports 8,982 packages for that keyword, but its search endpoint stops
returning new names past roughly 5,250 (deeper pages repeat earlier results).
That gap is an upstream API limit, not a filter applied here. Packages outside
it can still be installed by name through `plugin_manager`.

## How `engines.dsh` is produced

This matters, because most community plugins never declare it.

1. **Declared** — the package's own `engines.dsh` is used verbatim. Authoritative.
   Marked with the *Declares DSH range* label.
2. **Derived** — the package declares no `engines.dsh`, but it does pin
   `@deepseek-ai/dsh-*` peers. Those packages ship in lockstep with the dsh
   runtime (dsh-tools `0.2.1-rc.2` belongs to dsh `0.2.1-rc.2`), so joining the
   peer ranges with spaces — SemVer AND — yields the runtime range that
   satisfies every core peer. Marked with the *Derived DSH range* label.
   **Treat this as a pointer, not a promise.**
3. **Absent** — no usable signal. No `engines.dsh` is emitted, so DSH will not
   claim the plugin fits anything. Marked *No DSH range*.

`@deepseek-ai/cordis` peers are deliberately ignored: cordis is versioned 4.x
and says nothing about the dsh runtime. Peer ranges containing `||` are skipped,
because mixing a union into an AND expression changes its meaning.

## Chinese descriptions

`description` is emitted as `{ "en": <original>, "zh": <machine translation> }`.
DSH renders whichever entry matches the UI language, so a Chinese UI shows 中文
and an English one shows the original. **The English text is kept verbatim and is
the only authoritative wording** — translations are a reading aid, and anything
technical (version constraints, option meanings, limits) must be checked against
`en`.

- Only descriptions containing no CJK characters are translated. Roughly 1,600
  packages already publish Chinese descriptions and are left untouched.
- `translations.json` caches each translation by the SHA-256 of its source text,
  so a refresh pays only for text that is new or actually changed.
- `translate.mjs` needs `DEEPSEEK_API_KEY`. Without it the index still validates;
  only the localized text is missing, and CI skips that step.
- Useful side effect: market search matches every language of a description, so
  Chinese keywords now find plugins described only in English.

## Regenerating

```bash
node generate.mjs                                    # defaults
TIER1=2000 MAX_TOTAL=9000 MAX_VERSIONS=40 node generate.mjs
```

| Env | Default | Meaning |
|---|---:|---|
| `TIER1` | 300 | How many packages (by monthly downloads) get full version history |
| `MAX_TOTAL` | 3000 | Cap on packages pulled from the npm search API |
| `MAX_VERSIONS` | 40 | Versions kept per tier-1 package |
| `CONCURRENCY` | 10 | Parallel registry requests |

Output is `market.json`, validated in CI with the official
`@deepseek-ai/dsh-plugin-market-index` parser before it is committed.

## Scope and honesty

- This is an **index, not a curation**. Inclusion means "published to npm with
  the `dsh-plugin` keyword", nothing more. There is no review, no security
  audit, and no guarantee that a package works.
- Package names, descriptions, and authors come straight from npm and are
  third-party text. DSH itself treats market metadata as untrusted.
- The registry tag is self-applied, so junk and name-squats are included by
  design. Read an entry's repository before installing anything.
- No official endorsement. DeepSeek runs no plugin registry; this repository
  is one community index among several.

## License

The generator and the generated index are released under MIT. Indexed packages
keep their own licenses — the index only links to them.
