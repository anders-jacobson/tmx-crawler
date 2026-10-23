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

A JSON report next to the TMX lists every page with its status, skip reason, page ids and
structural match statistics, samples of conflicting translations, and – under `rejected` – up to
`output.rejectedSamplesPerReason` (default 50) rejected pairs per reason, each with the English and
German text, a readable detail (e.g. `numbers [25] vs [26]`, `missing in target: Servo-u`) and both
page URLs. That makes every quality check reviewable and tunable on evidence.

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
   With `extraction.pageIdentity` the target must also carry the **same page id** as the source
   (Optimizely renders it as `<meta name="pageid">`, identical in every language) and be an actual
   target-language content version (`<meta name="pagecontent" content="produkte_picco_de_10654">`);
   pages where the CMS silently serves the English content under `/de/` are reported as having no
   German version. A failing candidate is skipped and the next one is tried.
4. **Extraction** (cheerio) – site chrome is removed first: navigation, language/region selectors,
   cookie/consent banners (generic, OneTrust, Cookiebot, Usercentrics), footers and legal
   disclaimers, plus any site-specific `extraNoiseSelectors`. Blocks containing live widgets
   (`<time>`, clocks, countdowns, counters, `aria-live`) are dropped entirely so no half sentences
   reach the TM. Text is then taken from `h1, h2, h3, p, li` inside **every** element matching
   `contentRoot` (so a hero banner that sits outside `<main>` is included), innermost element only.
   Collapsed accordion/tab panels are kept.
5. **Alignment** – a source block is paired only with the target block at the **same layout
   position within the same CMS block**:
   - with `anchors` – elements whose identifier is the same in every language – pairing happens
     inside the innermost anchor: CMS blocks (`[id^="block-"]` on Optimizely/EPiServer) and list
     items such as product cards (`data-item-id="pulsiocare-1851545"`, where a `pattern` extracts
     the language-independent content id `1851545`). Re-ordered blocks, products listed in a
     different order, and blocks or products that exist on only one language version therefore
     cannot cause wrong pairs
   - `strict` (default): same tag path *and* same number of same-tag siblings at every level within
     the block, so an extra paragraph can never shift later segments into wrong pairs
   - `path`: same tag path only (more recall, less safe) · `sequence`: n-th ↔ n-th, equal counts only
6. **Filtering** – normalised text (NFC, whitespace collapsed, soft hyphens/zero-width removed);
   source segment must be **4–80 words**. A pair is rejected when the target is untranslated or
   still reads as the source language (English brand or campaign titles kept verbatim inside the
   German text are allowed), when the length ratio is implausible, when the numbers differ
   (`1,000.5` and `1.000,5` count as equal, and `2 or 3` matches `zwei oder drei`), or when
   brand/model tokens and parenthesised acronyms (`PiCCO`, `Servo-u`, `T-DOC`, `(IABP)`) do not
   carry over – the typical sign of two different items. Exact duplicates are removed across the
   whole site; conflicting translations keep the first and are listed in the report.

**Design principle – the website translations are approved.** The target pages have been
reviewed and approved by human reviewers, so free adaptations ("A Touch of Clarity" →
"Ein klares Konzept") are deliberate and belong in the TM. The checks therefore only test whether
two texts *correspond* (same CMS object, same position, same numbers and product names, right
language) and never penalise free wording. Any future semantic-similarity check must be tuned
to accept such adaptations.

**Measured accuracy.** 30-page Getinge run (en → de): 202 units, 192 correct (95 %); all errors
came from market-specific listings and one dropped product name. After excluding the article
teaser grid and the fixes above, a replay of the same data gives 189 units with 0 known errors.
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
| `extraction.anchors` | `null` | `[{ selector, attribute?, pattern? }]` – elements whose id is shared across languages; `pattern`'s first capture group is the id (see `tmx.config.json`) |
| `extraction.extraNoiseSelectors` | `[]` | Site-specific selectors to strip, added to the built-in list |
| `alignment.mode` | `strict` | `strict`, `path` or `sequence` |
| `alignment.minWords` / `maxWords` | `4` / `80` | Segment length filter |
| `alignment.minWordsByTag` | `{}` | Per-element minimum, e.g. `{ "h2": 1 }` keeps short headings (Getinge: h1–h4 = 1) |
| `alignment.lengthRatioMinWords` | `4` | Length-ratio check only from this many words (ratios are meaningless for "FAQ") |
| `alignment.minLengthRatio` / `maxLengthRatio` | `0.5` / `2.5` | Target/source character ratio |
| `alignment.requireNumberMatch` | `true` | Reject pairs whose numbers differ |
| `alignment.requireProtectedTokens` | `true` | Reject pairs where brand/model names or `(ACRONYMS)` are missing in the target |
| `alignment.checkTargetLanguage` | `true` | Reject targets that still read as the source language (en, de, sv, fr, es, it, nl) |
| `output.file` / `reportFile` | `output/<src>-<tgt>.tmx` | Output paths |
| `output.includeProvenance` | `true` | Add source/target URL `<prop>`s to each `<tu>` |
| `output.rejectedSamplesPerReason` | `50` | Rejected pairs listed per reason in the report |
| `extraction.pageIdentity` | `null` | `{ id: {selector, attribute}, contentLanguage: {selector, attribute, pattern}, required }` – page id that must match across languages, and the rendered content language |

The full default set is in [`src/config.js`](src/config.js).

**Getinge (`tmx.config.json`)** uses `.Banner-main, main#Main` as content roots (the hero banner
sits outside `<main>`) and three anchor types: CMS blocks (`block-…`), product cards
(`data-item-id`) and solution-list items (`itm…_<id>`). It strips the news list, event list, teaser
slider navigation and modal dialogs, plus two things measured to cause wrong pairs on real pages:
related-article and article-grid teaser cards (`.ColorTeaser`, `.Article-teaser`; their text is
aligned from the article pages themselves) and product listings – the product list component and individual product cards
(`.ProductList`, `.ProductList-item`), whose content differs per market. Product pages themselves
are still crawled and aligned.

Buttons and calls to action are excluded **by their markup, not their length**: `.CallToAction`
(CTA containers, "Read more about …" lines on cards, request forms), `.Button`, `a.Link`, tab
labels, download links and form buttons. Headings (h1–h4) are kept **regardless of length**, so
short terminology such as "Transpulmonary thermodilution" → "Transpulmonale Thermodilution"
enters the TM; accordion titles survive because only CTA classes are removed, never every
`<button>`. Measured on 17 real page pairs: 73 additional heading pairs, all correct. Two things to
know: a single-word heading may carry a context-specific choice (the section title "Insights" is
"News & Events" in German), and the same heading translated differently on two pages shows up in
the report's `conflicts` list – set a heading minimum of 2 words if you prefer to skip one-word
headings. `/company/`, `/news/`, `/insights/events/` and CMS `/settings/` pages are excluded.
Market-specific pages such as the homepage share only some blocks with `/int/`; anything that is
not the same block in both languages is ignored.

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
