#!/usr/bin/env node
/**
 * CLI: crawl two language variants of a site and build a DeepL-compatible TMX 1.4 file.
 *
 *   node bin/build-tmx.js --config tmx.config.json
 *   node bin/build-tmx.js --source https://www.getinge.com/int/ --target https://www.getinge.com/de/ --target-lang de
 */

import { appendFile, access } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { createLogger } from '../src/logger.js';
import { loadConfigFile, resolveConfig } from '../src/config.js';
import { runPipeline, TOOL_NAME, TOOL_VERSION } from '../src/pipeline.js';

const HELP = `${TOOL_NAME} ${TOOL_VERSION}
Crawls parallel language variants of a website and writes a TMX 1.4 translation memory.

Usage: build-tmx [options]

Options:
  -c, --config <file>       JSON config file (default: ./tmx.config.json when present)
      --source <url>        Source-language base URL      e.g. https://www.getinge.com/int/
      --target <url>        Target-language base URL      e.g. https://www.getinge.com/de/
      --source-lang <code>  Source language (default: en)
      --target-lang <code>  Target language (default: de)
      --sitemap <url|auto|none>
                            Discover pages from a sitemap.xml; "auto" reads robots.txt
                            Sitemap: lines; "none" forces a recursive crawl.
                            An unusable sitemap also falls back to crawling.
      --max-pages <n>       Maximum source pages to visit (default: 500)
      --max-depth <n>       Maximum link depth when crawling (default: 6)
      --delay <ms>          Minimum delay between requests (default: 500)
      --concurrency <n>     Parallel page workers (default: 2)
      --mapping <mode>      auto | hreflang | path            (default: auto)
      --align-mode <mode>   strict | path | sequence          (default: strict)
      --out <file>          TMX output path (default: output/<src>-<tgt>.tmx)
      --report <file>       JSON report path (default: output/<src>-<tgt>.report.json)
      --no-robots           Do not consult robots.txt (only for sites you own/operate)
      --log-level <level>   debug | info | warn | error (default: info)
      --log-json            Log as JSON lines
  -h, --help                Show this help
  -v, --version             Show version

Exit codes: 0 success · 1 error / verification failed · 2 no translation units · 130 interrupted
`;

const OPTIONS = {
  config: { type: 'string', short: 'c' },
  source: { type: 'string' },
  target: { type: 'string' },
  'source-lang': { type: 'string' },
  'target-lang': { type: 'string' },
  sitemap: { type: 'string' },
  'max-pages': { type: 'string' },
  'max-depth': { type: 'string' },
  delay: { type: 'string' },
  concurrency: { type: 'string' },
  mapping: { type: 'string' },
  'align-mode': { type: 'string' },
  out: { type: 'string' },
  report: { type: 'string' },
  'no-robots': { type: 'boolean' },
  'log-level': { type: 'string' },
  'log-json': { type: 'boolean' },
  help: { type: 'boolean', short: 'h' },
  version: { type: 'boolean', short: 'v' },
};

function toInt(value, flag) {
  if (value === undefined || value === '') return undefined;
  const n = Number(value);
  if (!Number.isInteger(n)) throw new Error(`--${flag} expects an integer (got "${value}")`);
  return n;
}

const emptyToUndefined = (value) => (value === '' ? undefined : value);

function cliLayer(values) {
  return {
    source: { baseUrl: emptyToUndefined(values.source), lang: emptyToUndefined(values['source-lang']) },
    target: { baseUrl: emptyToUndefined(values.target), lang: emptyToUndefined(values['target-lang']) },
    discovery: {
      sitemapUrl: values.sitemap === 'none' ? null : emptyToUndefined(values.sitemap),
      maxPages: toInt(values['max-pages'], 'max-pages'),
      maxDepth: toInt(values['max-depth'], 'max-depth'),
    },
    http: {
      delayMs: toInt(values.delay, 'delay'),
      concurrency: toInt(values.concurrency, 'concurrency'),
      respectRobotsTxt: values['no-robots'] ? false : undefined,
    },
    alignment: { mapping: emptyToUndefined(values.mapping), mode: emptyToUndefined(values['align-mode']) },
    output: { file: emptyToUndefined(values.out), reportFile: emptyToUndefined(values.report) },
    logging: { level: emptyToUndefined(values['log-level']), json: values['log-json'] || undefined },
  };
}

const fmtInt = (n) => (n ?? 0).toLocaleString('en-US');
// Decimal units, matching how DeepL states its 1 GB upload limit.
function fmtBytes(bytes) {
  if (bytes < 1e3) return `${bytes} B`;
  if (bytes < 1e6) return `${(bytes / 1e3).toFixed(1)} kB`;
  if (bytes < 1e9) return `${(bytes / 1e6).toFixed(2)} MB`;
  return `${(bytes / 1e9).toFixed(2)} GB`;
}

function summaryRows(s) {
  const p = s.pages;
  const v = s.tmx.verification;
  const share = ((s.tmx.bytes / s.tmx.maxBytes) * 100).toFixed(4);
  return [
    ['Source', `${s.source.baseUrl} (${s.source.lang})`],
    ['Target', `${s.target.baseUrl} (${s.target.lang})`],
    ['Discovery', `${s.discovery.mode}, ${fmtInt(s.discovery.urlsQueued)} URL(s) queued, ${fmtInt(s.requests)} HTTP request(s)`],
    ['Pages crawled', `${fmtInt(p.sourcePagesFetched)} source / ${fmtInt(p.targetPagesFetched)} target`],
    ['Page pairs', `${fmtInt(p.pagePairsAligned)} aligned, ${fmtInt(p.pagesSkipped)} skipped, ${fmtInt(p.pagesFailed)} failed`],
    ['Translation units', `${fmtInt(s.tmx.translationUnits)} <tu> written (${fmtInt(s.segments.duplicatesRemoved)} duplicates, ${fmtInt(s.segments.conflictsRemoved)} conflicting variants removed, ${fmtInt(s.segments.divergentSourcesDropped ?? 0)} ambiguous sources left out)`],
    ['Output file', `${s.tmx.file} (${fmtBytes(s.tmx.bytes)})`],
    ['DeepL size limit', `${s.tmx.withinUploadLimit ? 'OK' : 'EXCEEDED'} – ${share}% of ${fmtBytes(s.tmx.maxBytes)}`],
    ['Verification', v.ok ? `PASSED (well-formed XML, TMX 1.4 structure, ${fmtInt(v.units)} <tu>)` : `FAILED – ${v.problems.join('; ')}`],
  ];
}

function printSummary(summary, reportFile) {
  const rows = summaryRows(summary);
  if (reportFile) rows.push(['Report', reportFile]);
  if (summary.interrupted) rows.push(['Note', 'Run was interrupted – output contains the pages processed so far']);
  const width = Math.max(...rows.map(([k]) => k.length));
  process.stdout.write(`\n=== TMX build summary ===\n${rows.map(([k, v]) => `${k.padEnd(width)}  ${v}`).join('\n')}\n`);
  const rejected = Object.entries(summary.segments.rejected);
  if (rejected.length) {
    process.stdout.write(`Rejected segments  ${rejected.map(([k, n]) => `${k}: ${fmtInt(n)}`).join(', ')}\n`);
  }
}

async function writeGithubSummary(summary, reportFile) {
  const file = process.env.GITHUB_STEP_SUMMARY;
  if (!file) return;
  const rows = summaryRows(summary);
  if (reportFile) rows.push(['Report', reportFile]);
  const md = ['### TMX build summary', '', '| | |', '|---|---|', ...rows.map(([k, v]) => `| ${k} | ${String(v).replace(/\|/g, '\\|')} |`), ''];
  await appendFile(file, `${md.join('\n')}\n`).catch(() => {});
}

async function fileExists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function main() {
  const { values } = parseArgs({ options: OPTIONS, allowPositionals: false, strict: true });
  if (values.help) {
    process.stdout.write(HELP);
    return 0;
  }
  if (values.version) {
    process.stdout.write(`${TOOL_VERSION}\n`);
    return 0;
  }

  const configPath = values.config ?? ((await fileExists('tmx.config.json')) ? 'tmx.config.json' : null);
  const fileLayer = configPath ? await loadConfigFile(configPath) : {};
  const config = resolveConfig(fileLayer, cliLayer(values));
  const logger = createLogger({ level: config.logging.level, json: config.logging.json });

  if (configPath) logger.info(`Using config file ${configPath}`);
  logger.info(`Mapping ${config.source.baseUrl} (${config.source.lang}) → ${config.target.baseUrl} (${config.target.lang})`, {
    delayMs: config.http.delayMs,
    concurrency: config.http.concurrency,
    alignment: config.alignment.mode,
  });

  const controller = new AbortController();
  let interrupts = 0;
  const onSignal = (sig) => {
    interrupts += 1;
    if (interrupts > 1) {
      logger.error(`Second ${sig} – exiting immediately`);
      process.exit(130);
    }
    logger.warn(`${sig} received – finishing in-flight work and writing partial output (press again to abort)`);
    controller.abort(new Error(`Interrupted by ${sig}`));
  };
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);

  const summary = await runPipeline(config, { logger, signal: controller.signal });
  printSummary(summary, config.output.reportFile);
  await writeGithubSummary(summary, config.output.reportFile);

  if (!summary.tmx.verification.ok || !summary.tmx.withinUploadLimit) return 1;
  if (summary.interrupted) return 130;
  if (summary.tmx.translationUnits === 0) {
    logger.warn('No translation units were aligned – check the report for skip reasons');
    return 2;
  }
  return 0;
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (error) => {
    process.stderr.write(`\nERROR: ${error.message}\n`);
    if (process.env.DEBUG) process.stderr.write(`${error.stack}\n`);
    process.exitCode = 1;
  },
);
