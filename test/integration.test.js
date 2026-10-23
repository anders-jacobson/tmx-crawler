/**
 * End-to-end: crawl the local mock site in both discovery modes and validate the TMX output.
 */

import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { XMLParser } from 'fast-xml-parser';
import { resolveConfig, runPipeline } from '../src/index.js';
import { startMockSite } from './fixtures/mock-site.js';
import { hasXmllint, tempDir, validateWithDtd } from './helpers.js';

const USER_AGENT = 'IntegrationTestAligner/1.0 (+tests)';
const CLI = fileURLToPath(new URL('../bin/build-tmx.js', import.meta.url));

function readUnits(xml) {
  const doc = new XMLParser({
    ignoreAttributes: false,
    parseTagValue: false,
    trimValues: false,
    isArray: (n) => ['tu', 'tuv', 'prop'].includes(n),
  }).parse(xml);
  return (doc.tmx.body.tu ?? []).map((tu) => ({
    en: tu.tuv.find((t) => t['@_xml:lang'] === 'en').seg,
    de: tu.tuv.find((t) => t['@_xml:lang'] === 'de').seg,
  }));
}

describe('end-to-end against a local mirrored site', () => {
  let site;
  let dir;

  before(async () => {
    site = await startMockSite();
    dir = await tempDir('tmx-e2e-');
  });
  after(() => site.close());

  const configFor = (name, discovery = {}) => resolveConfig({
    source: { baseUrl: `${site.baseUrl}/int/`, lang: 'en' },
    target: { baseUrl: `${site.baseUrl}/de/`, lang: 'de' },
    discovery: { maxPages: 50, ...discovery },
    http: { delayMs: 0, concurrency: 3, retries: 2, backoffBaseMs: 5, timeoutMs: 5000, userAgent: USER_AGENT },
    output: { file: join(dir, `${name}.tmx`), reportFile: join(dir, `${name}.report.json`) },
  });

  test('recursive crawl mode', async () => {
    const config = configFor('crawl');
    const summary = await runPipeline(config);

    assert.equal(summary.discovery.mode, 'crawl');
    assert.equal(summary.pages.sourcePagesFetched, 7);
    assert.equal(summary.pages.pagePairsAligned, 4); // home, about, products, localized
    assert.equal(summary.pages.pagesFailed, 0);
    assert.equal(summary.tmx.translationUnits, 13);
    assert.equal(summary.segments.duplicatesRemoved, 1);
    assert.deepEqual(summary.segments.rejected, {
      'word-range': 2,
      untranslated: 1,
      'number-mismatch': 1,
      'no-structural-match': 4,
    });
    assert.ok(summary.tmx.verification.ok, summary.tmx.verification.problems.join('; '));
    assert.ok(summary.tmx.withinUploadLimit);

    const xml = await readFile(config.output.file, 'utf8');
    const units = readUnits(xml);
    const pairs = new Map(units.map((u) => [u.en, u.de]));

    // Correct pairs, incl. special characters and a locale-formatted number
    assert.equal(pairs.get('Passion for life in every hospital'), 'Leidenschaft für das Leben in jedem Krankenhaus');
    assert.equal(
      pairs.get(`Fish & Chips <tasty> "quoted" 'single' special characters`),
      `Fisch & Pommes <lecker> „zitiert“ 'einfach' Sonderzeichen`,
    );
    assert.equal(
      pairs.get('Founded in 1904, the company now employs more than 10,000 people worldwide.'),
      'Das 1904 gegründete Unternehmen beschäftigt heute weltweit mehr als 10.000 Mitarbeitende.',
    );
    assert.equal(pairs.get('Quality assured products and services for every patient.'),
      'Qualitätsgesicherte Produkte und Dienstleistungen für jeden Patienten.', 'control character removed');
    assert.equal(pairs.get('Localized URL slugs are supported'), 'Lokalisierte URL-Pfade werden unterstützt',
      'page-level hreflang alternate used for a localised slug');

    // Noise, dynamic widgets, filtered and misaligned content must not be in the TMX
    const everything = units.map((u) => `${u.en}\n${u.de}`).join('\n');
    for (const forbidden of [
      /cookies/i, /healthcare professionals and is for informational/, /language selector/i,
      /Next event starts/, /Local time/, /Currently 12 events/, /Read more/, /Servo-air Lite/,
      /25 production sites/, /Sentence number/, /deutschen Seite/, /Ventilators for adults/,
      /not been translated/, /only exists in the English/, /redirects to the start page/, /never be fetched/,
    ]) {
      assert.doesNotMatch(everything, forbidden);
    }

    // Politeness: robots.txt respected, descriptive UA on every request, 503 retried
    assert.equal(site.hits.get('/int/private/secret/'), undefined, 'robots-disallowed page was never requested');
    assert.deepEqual([...site.userAgents], [USER_AGENT]);
    assert.equal(site.hits.get('/de/about/'), 2, 'transient 503 was retried once');

    const report = JSON.parse(await readFile(config.output.reportFile, 'utf8'));
    const byUrl = new Map(report.pages.map((p) => [new URL(p.sourceUrl).pathname, p]));
    assert.match(byUrl.get('/int/missing/').reason, /HTTP 404/);
    assert.match(byUrl.get('/int/moved/').reason, /redirected to/);
    assert.match(byUrl.get('/int/fallback/').reason, /lang="en"/);
    assert.match(byUrl.get('/int/private/secret/').reason, /robots/);
    assert.equal(byUrl.get('/int/localized/').targetUrl, `${site.baseUrl}/de/lokalisiert/`);

    if (await hasXmllint()) await validateWithDtd(config.output.file);
  });

  test('sitemap mode (auto-discovered via robots.txt, index + gzip + broken child sitemap)', async () => {
    const config = configFor('sitemap', { sitemapUrl: 'auto' });
    const summary = await runPipeline(config);

    assert.equal(summary.discovery.mode, 'sitemap');
    assert.equal(summary.discovery.followLinks, false);
    assert.equal(summary.discovery.sitemap.errors.length, 1, 'broken child sitemap is reported, not fatal');
    assert.equal(summary.tmx.translationUnits, 15);
    assert.ok(summary.tmx.verification.ok);

    const units = readUnits(await readFile(config.output.file, 'utf8'));
    const pairs = new Map(units.map((u) => [u.en, u.de]));
    assert.equal(pairs.get('Sitemap alternates map localized slugs'), 'Sitemap-Alternativen ordnen lokalisierte Pfade zu',
      'sitemap-level hreflang alternate used for a localised slug');
    assert.ok(pairs.has('Localized URL slugs are supported'), 'URL from the gzip-compressed sitemap was crawled');

    if (await hasXmllint()) await validateWithDtd(config.output.file);
  });

  test('falls back to crawling when the sitemap is unusable', async () => {
    const config = configFor('fallback', { sitemapUrl: `${site.baseUrl}/does-not-exist.xml` });
    const summary = await runPipeline(config);
    assert.equal(summary.discovery.mode, 'crawl');
    assert.equal(summary.tmx.translationUnits, 13);
  });

  test('CLI prints the verification summary and exits 0', async () => {
    const out = join(dir, 'cli.tmx');
    const { stdout } = await promisify(execFile)(process.execPath, [
      CLI,
      '--config', fileURLToPath(new URL('../tmx.config.json', import.meta.url)),
      '--source', `${site.baseUrl}/int/`,
      '--target', `${site.baseUrl}/de/`,
      '--delay', '0',
      '--concurrency', '3',
      '--out', out,
      '--report', join(dir, 'cli.report.json'),
      '--log-level', 'warn',
    ]);
    // tmx.config.json uses sitemapUrl "auto", so the CLI run discovers pages via the sitemap
    assert.match(stdout, /Discovery\s+sitemap/);
    assert.match(stdout, /Pages crawled\s+7 source/);
    assert.match(stdout, /Translation units\s+15 <tu> written/);
    assert.match(stdout, /DeepL size limit\s+OK/);
    assert.match(stdout, /Verification\s+PASSED/);
  });
});
