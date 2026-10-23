# site-tmx-aligner

Crawls two language variants of the same website (for example `https://www.getinge.com/int/` and
`https://www.getinge.com/de/`), aligns their text segment by segment using the DOM structure, and
writes a **TMX 1.4** translation memory that can be imported into **DeepL** (or any CAT tool).

[![CI](https://github.com/anders-jacobson/tmx-crawler/actions/workflows/ci.yml/badge.svg)](https://github.com/anders-jacobson/tmx-crawler/actions/workflows/ci.yml)

## Quick start

Requires Node.js 22 or newer.

```bash
npm ci
npm run build:tmx                    # uses tmx.config.json (Getinge /int/ → /de/)
```

Or override anything on the command line:

```bash
node bin/build-tmx.js \
  --source https://www.getinge.com/int/ --target https://www.getinge.com/de/ \
  --source-lang en --target-lang de \
  --sitemap auto --max-pages 300 --delay 500 \
  --out output/getinge-en-de.tmx
```

`node bin/build-tmx.js --help` lists every option. At the end of each run a summary is printed:

```
=== TMX build summary ===
Discovery          sitemap, 8 URL(s) queued, 23 HTTP request(s)
Pages crawled      7 source / 7 target
Page pairs         5 aligned, 3 skipped, 0 failed
Translation units  15 <tu> written (1 duplicates, 0 conflicts removed)
Output file        output/getinge-en-de.tmx (6.3 kB)
DeepL size limit   OK – 0.0006% of 1.00 GB
Verification       PASSED (well-formed XML, TMX 1.4 structure, 15 <tu>)
```

A JSON report next to the TMX lists every page with its status, skip reason, structural match
statistics and rejected-segment counts, plus samples of conflicting translations.

## Building on GitHub

| Workflow | Trigger | What it does |
|---|---|---|
| **CI** (`ci.yml`) | push to `main`, pull requests | ESLint + full test suite on Node 22 and 24, incl. DTD validation of generated TMX with `xmllint` |
| **Build TMX** (`build-tmx.yml`) | *Actions → Build TMX → Run workflow* | Crawls the site with the inputs you choose, uploads `output/` (TMX + report) as a workflow artifact for 30 days, writes the summary to the job page, and optionally publishes the TMX as a GitHub Release |

A weekly schedule is prepared (commented out) at the top of `build-tmx.yml`. Dependabot keeps
npm packages and Actions up to date.

## How it works

1. **Discovery** – either a sitemap (`--sitemap <url>`, or `auto` to read the `Sitemap:` lines in
   robots.txt; sitemap indexes and `.xml.gz` files are supported) or a recursive, same-scope crawl
   starting at the source base URL. If the sitemap is unusable the tool falls back to crawling.
2. **Politeness** – a single rate limiter guarantees `delayMs` between *all* requests regardless of
   concurrency; robots.txt rules and `Crawl-delay` are honoured; a descriptive User-Agent is sent;
   429/5xx/timeouts are retried with exponential backoff and `Retry-After`.
3. **Page mapping** (`alignment.mapping`)
   - `auto` (default): hreflang alternate from the sitemap → `<link rel="alternate" hreflang>` on
     the page → structural mirroring of the path (`/int/x/` → `/de/x/`), first one returning 200 wins
   - `hreflang` or `path` to force one strategy
   Both pages must return **200 OK** with HTML. A target that redirects elsewhere (typically to the
   German start page) or declares a different `<html lang>` (an untranslated fallback) is skipped.
4. **Extraction** (cheerio) – site chrome is removed first: navigation, language/region selectors,
   cookie/consent banners (generic, OneTrust, Cookiebot, Usercentrics), footers and legal
   disclaimers, plus any site-specific `extraNoiseSelectors`. Blocks containing live widgets
   (`<time>`, clocks, countdowns, counters, `aria-live`) are dropped entirely so no half sentences
   reach the TM. Text is then taken from `h1, h2, h3, p, li` inside **every** element matching
   `contentRoot` (so a hero banner that sits outside `<main>` is included), innermost element only.
   Collapsed accordion/tab panels are kept.
5. **Alignment** – a source block is paired only with the target block at the **same layout
   position within the same CMS block**:
   - with `anchorSelector` (e.g. `[id^="block-"]` on Optimizely/EPiServer sites, whose block ids are
     identical in every language) pairing is block-to-block, so re-ordered blocks and blocks that
     exist on only one language version cannot cause wrong pairs
   - `strict` (default): same tag path *and* same number of same-tag siblings at every level within
     the block, so an extra paragraph can never shift later segments into wrong pairs
   - `path`: same tag path only (more recall, less safe) · `sequence`: n-th ↔ n-th, equal counts only
6. **Filtering** – normalised text (NFC, whitespace collapsed, soft hyphens/zero-width removed);
   source segment must be **4–80 words**. A pair is rejected when the target is untranslated or
   still reads as the source language, when the length ratio is implausible, when the numbers
   differ (`1,000.5` and `1.000,5` count as equal), or when brand/model tokens and parenthesised
   acronyms (`PiCCO`, `Servo-u`, `(IABP)`) do not carry over – the typical sign of list items in a
   different order. Exact duplicates are removed across the whole site; conflicting translations
   keep the first and are listed in the report.
7. **TMX 1.4** – streamed with `xmlbuilder2` (`<tmx version="1.4">`, header with
   `segtype="sentence" o-tmf="UTF-8" srclang="en"` and all attributes TMX 1.4 requires, one `<tu>`
   with two `<tuv xml:lang>` per pair, optional `x-source-url`/`x-target-url` props). Characters
   illegal in XML 1.0 are stripped and all of `& < > " '` are escaped explicitly. The file is
   written to `*.partial` and renamed only on success, then re-parsed and verified (well-formed
   XML, TMX structure, TU count, size below DeepL's 1 GB limit).

Ctrl+C stops the crawl gracefully and still writes a valid TMX with the pages processed so far
(press twice to abort immediately).

## Configuration

Defaults ← `tmx.config.json` ← CLI flags. The most important settings:

| Key | Default | Meaning |
|---|---|---|
| `source.baseUrl` / `target.baseUrl` | – | Base URLs of the two language variants |
| `source.lang` / `target.lang` | `en` / `de` | Language codes written to `xml:lang` |
| `discovery.sitemapUrl` | `null` | Sitemap URL, `"auto"`, or `null` for crawling |
| `discovery.maxPages` / `maxDepth` | `500` / `6` | Crawl limits |
| `discovery.include` / `exclude` | file types, `/search/` | Regular expressions on source URLs (the Getinge config also excludes `/company/` and `/news/`) |
| `discovery.order` | `shallow-first` | Visit landing/section pages before deep leaf pages, so small samples are representative |
| `http.userAgent` | descriptive UA | **Put a contact URL or address here** |
| `http.delayMs` / `concurrency` | `500` / `2` | Politeness settings |
| `http.respectRobotsTxt` | `true` | Disable only for sites you operate (`--no-robots`) |
| `extraction.contentRoot` | `main, [role="main"]` | Where translatable copy lives; all outermost matches are used |
| `extraction.anchorSelector` | `null` | CMS blocks whose id is shared across languages, e.g. `[id^="block-"]` |
| `extraction.extraNoiseSelectors` | `[]` | Site-specific selectors to strip, added to the built-in list |
| `alignment.mode` | `strict` | `strict`, `path` or `sequence` |
| `alignment.minWords` / `maxWords` | `4` / `80` | Segment length filter |
| `alignment.minLengthRatio` / `maxLengthRatio` | `0.5` / `2.5` | Target/source character ratio |
| `alignment.requireNumberMatch` | `true` | Reject pairs whose numbers differ |
| `alignment.requireProtectedTokens` | `true` | Reject pairs where brand/model names or `(ACRONYMS)` are missing in the target |
| `alignment.checkTargetLanguage` | `true` | Reject targets that still read as the source language (en, de, sv, fr, es, it, nl) |
| `output.file` / `reportFile` | `output/<src>-<tgt>.tmx` | Output paths |
| `output.includeProvenance` | `true` | Add source/target URL `<prop>`s to each `<tu>` |

The full default set is in [`src/config.js`](src/config.js).

**Getinge (`tmx.config.json`)** uses `.Banner-main, main#Main` as content roots (the hero banner
sits outside `<main>`), `[id^="block-"]` as anchors, and strips the news list, event list, teaser
slider navigation and modal dialogs. Market-specific pages such as the homepage share only some
blocks with `/int/`; anything that is not the same block in both languages is ignored.

**Tuning tip:** start with `--max-pages 20`, open the report, and look at
`no-structural-match` counts. If the two language variants differ structurally on many pages,
`--align-mode path` recovers more segments (review the result before importing).

## Importing into DeepL

Upload the `.tmx` in DeepL's translation memory settings, or via the API: create a translation
memory import job, `PUT` the file to the returned `upload_url`, and poll the job until it reports
`completed`. See the [DeepL API documentation](https://developers.deepl.com/api-reference/translation-memory/import-a-translation-memory).

## Exit codes

`0` success · `1` configuration error, fatal error or failed verification · `2` no translation
units aligned · `130` interrupted (partial output written)

## Development

```bash
npm run lint
npm test          # unit tests + end-to-end tests against a local mock site
```

```
bin/build-tmx.js     CLI
src/pipeline.js      orchestration: discovery → fetch → align → write → verify
src/http-client.js   rate limiter, retries, timeouts, body limits, charset decoding
src/robots.js        robots.txt (RFC 9309) cache
src/sitemap.js       sitemap / sitemap index / gzip parsing incl. hreflang alternates
src/extract.js       cheerio DOM cleaning and block extraction with structural paths
src/align.js         positional alignment, quality gates, de-duplication
src/tmx-writer.js    streaming TMX 1.4 writer, escaping, verification
test/                node:test suites, mock bilingual site, TMX 1.4b DTD
```

Only crawl sites you are permitted to crawl, and keep the default politeness settings for
third-party sites.
