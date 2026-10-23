import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate';
import { resolveConfig, runPipeline } from '../src/index.js';
import {
  DECISIONS,
  decisionsFromRows,
  pairSimilarity,
  readReviewFolder,
  readReviewRows,
  suggestPairs,
  writeReviewWorkbook,
} from '../src/review.js';
import { startMockSite } from './fixtures/mock-site.js';
import { tempDir } from './helpers.js';

const block = (tag, text, index = 0) => ({ tag, text, index });

test('suggestPairs follows a restructured German article', () => {
  const region = {
    source: [
      block('p', 'Endoscopes are reprocessed many times during every single day.'),
      block('p', 'Challenge 1: tracking every device in the department'),
      block('p', 'Busy endoscopy units use many similar endoscopes during the day.'),
      block('p', 'This level of traceability is especially important for 7 device types.'),
    ],
    target: [
      block('p', 'Endoskope werden an jedem einzelnen Tag viele Male aufbereitet.'),
      block('h3', 'Herausforderung 1: Jedes Gerät in der Abteilung nachverfolgen'),
      block('p', 'Ausgelastete Endoskopieabteilungen nutzen am Tag viele ähnliche Endoskope.'),
      block('p', 'Diese Rückverfolgbarkeit ist für 7 Gerätetypen besonders wichtig.'),
      block('p', 'Mitarbeitende brauchen deshalb klare und eindeutige Anweisungen.'),
    ],
  };
  const items = suggestPairs(region, { sourceLang: 'en', targetLang: 'de' });
  assert.deepEqual(items.map((i) => i.suggestion?.text), region.target.slice(0, 4).map((b) => b.text));
  assert.ok(items.every((i) => i.alternatives.length <= 3));
  // Shared numbers make the correct partner outrank a same-length neighbour.
  const src = region.source[3];
  assert.ok(pairSimilarity(src, region.target[3], { sourceLang: 'en', targetLang: 'de' })
    > pairSimilarity(src, region.target[2], { sourceLang: 'en', targetLang: 'de' }));
});

test('suggestPairs follows a moved paragraph and never suggests untranslated text', () => {
  const items = suggestPairs({
    source: [
      block('p', 'Monitor the drying status, storage limits and all 12 process steps of every endoscope.'),
      block('p', 'Track the maintenance and repair status of all 40 devices in one place.'),
      block('p', 'Short guide: Flow Family waveforms and loops'),
      block('p', 'Short guide: Flow-c Anesthesia System'),
    ],
    target: [
      block('p', 'Verfolgen Sie den Wartungs- und Reparaturstatus aller 40 Geräte an einem Ort.'),
      block('p', 'Überwachen Sie Trocknungsstatus, Lagerfristen und alle 12 Prozessschritte jedes Endoskops.'),
      block('p', 'Short guide: Flow Family waveforms and loops'),
      block('p', 'Short guide: Flow-c Anesthesia System'),
    ],
  }, { sourceLang: 'en', targetLang: 'de', checkPair: (s, t) => (s.text === t.text ? { reason: 'untranslated' } : null) });
  // The German page swapped the two paragraphs: one is found in page order, the other by the
  // out-of-order pass. English texts the German page shows untranslated get no row – nor is one
  // offered for the other.
  assert.deepEqual(items.map((i) => [i.source.text.slice(0, 9), i.suggestion?.text.slice(0, 9) ?? null]), [
    ['Monitor t', 'Überwache'],
    ['Track the', 'Verfolgen'],
  ]);
});

test('suggestPairs leaves a block unpaired rather than forcing a weak match', () => {
  const items = suggestPairs({
    source: [block('p', 'Contact our service team for a quote today.')],
    target: [block('li', 'ISO 13485')],
  }, { sourceLang: 'en', targetLang: 'de' });
  assert.equal(items.length, 0, 'no suggestion and no plausible alternative → no review row');
});

/** Sets Decision (and optionally Your German) on the rows with the given English text. */
async function decide(file, decisions) {
  const rows = readReviewRows(await readFile(file));
  const files = unzipSync(new Uint8Array(await readFile(file)));
  let sheet = strFromU8(files['xl/worksheets/sheet1.xml']);
  const cell = (ref, text) => `<c r="${ref}" t="inlineStr"><is><t>${text}</t></is></c>`;
  for (const [english, decision, own] of decisions) {
    const r = rows.findIndex((row) => row.English.value === english) + 2;
    assert.ok(r > 1, `row for "${english}"`);
    sheet = sheet.replace(`<c r="F${r}" s="4"/>`, cell(`F${r}`, decision));
    if (own) sheet = sheet.replace(`<c r="J${r}" s="4"/>`, cell(`J${r}`, own));
  }
  files['xl/worksheets/sheet1.xml'] = strToU8(sheet);
  return zipSync(files);
}

test('review workbook round trip: decisions become approved pairs', async () => {
  const dir = await tempDir('tmx-review-');
  const file = join(dir, 'sheet.review.xlsx');
  await writeReviewWorkbook(file, [
    { sourceUrl: 'https://x.test/int/a/', targetUrl: 'https://x.test/de/a/', source: 'Fish & chips', suggestion: 'Fisch & Pommes', confidence: 'High', alternatives: [], check: null },
    { sourceUrl: 'https://x.test/int/b/', targetUrl: null, source: 'Second <row>', suggestion: null, confidence: '', alternatives: ['Zweite Zeile', 'Andere'], check: 'number-mismatch' },
    { sourceUrl: 'https://x.test/int/c/', targetUrl: null, source: 'Third row', suggestion: 'Dritte', confidence: 'Low', alternatives: [], check: null },
    { sourceUrl: 'https://x.test/int/d/', targetUrl: null, source: 'Fourth row', suggestion: 'Vierte', confidence: 'Low', alternatives: [], check: null },
    { sourceUrl: 'https://x.test/int/e/', targetUrl: null, source: 'Fifth row', suggestion: 'Fünfte', confidence: 'Low', alternatives: [], check: null },
  ], { sourceBase: 'https://x.test/int/', targetBase: 'https://x.test/de/' });

  const rows = readReviewRows(await readFile(file));
  assert.equal(rows.length, 5);
  assert.equal(rows[0].Page.value, '/a/');
  assert.equal(rows[1].English.value, 'Second <row>');

  await writeFile(file, await decide(file, [
    ['Fish & chips', DECISIONS.accept],
    ['Second <row>', DECISIONS.alt2],
    ['Third row', DECISIONS.reject],
    ['Fourth row', DECISIONS.own, 'Vierte Zeile, korrigiert'],
    ['Fifth row', DECISIONS.alt1], // no alternative → invalid
  ]));
  const decisions = decisionsFromRows(readReviewRows(await readFile(file)));
  assert.deepEqual(decisions.approved.map((p) => [p.source, p.target]), [
    ['Fish & chips', 'Fisch & Pommes'],
    ['Second <row>', 'Andere'],
    ['Fourth row', 'Vierte Zeile, korrigiert'],
  ]);
  assert.equal(decisions.approved[0].sourceUrl, 'https://x.test/int/a/');
  assert.equal(decisions.rejected, 1);
  assert.deepEqual(decisions.invalid, [{ row: 6, reason: '"Alternative 1" is empty' }]);
  assert.deepEqual([...decisions.decided].sort(), ['Fish & chips', 'Fourth row', 'Second <row>', 'Third row']);

  assert.deepEqual((await readReviewFolder(join(dir, 'missing'))).files, [], 'missing folder = nothing reviewed');
});

test('end to end: rewritten page → review sheet → approved pair in the TMX', async () => {
  const site = await startMockSite();
  try {
    const dir = await tempDir('tmx-review-e2e-');
    const reviewDir = join(dir, 'review');
    const configFor = (name) => resolveConfig({
      source: { baseUrl: `${site.baseUrl}/int/`, lang: 'en' },
      target: { baseUrl: `${site.baseUrl}/de/`, lang: 'de' },
      discovery: { sitemapUrl: `${site.baseUrl}/sitemap-review.xml` },
      http: { delayMs: 0, retries: 0, userAgent: 'TestBot/1.0 (+https://example.com/bot)' },
      alignment: { minWordsByTag: { h2: 1, h3: 1 } },
      output: { file: join(dir, `${name}.tmx`), reportFile: join(dir, `${name}.report.json`) },
      review: { inputDir: reviewDir },
    });

    const first = await runPipeline(configFor('first'));
    assert.equal(first.tmx.translationUnits, 1, 'only the heading before the layout difference is paired automatically');
    assert.equal(first.review.rows, 4);
    const sheet = join(dir, 'first.review.xlsx');
    const rows = readReviewRows(await readFile(sheet));
    assert.deepEqual(rows.map((r) => [r.English.value, r['Suggested German'].value]), [
      ['Endoscopes are reprocessed many times during every single day.', 'Endoskope werden an jedem einzelnen Tag viele Male aufbereitet.'],
      ['Challenge 1: tracking every device in the department', 'Herausforderung 1: Jedes Gerät in der Abteilung nachverfolgen'],
      ['Busy endoscopy units use many similar endoscopes during the day.', 'Ausgelastete Endoskopieabteilungen nutzen am Tag viele ähnliche Endoskope.'],
      ['This level of traceability is especially important for 7 device types.', 'Diese Rückverfolgbarkeit ist für 7 Gerätetypen besonders wichtig.'],
    ]);
    assert.match(rows[0].Page.formula, /HYPERLINK\(".*\/int\/rewritten\/"/);

    await mkdir(reviewDir, { recursive: true });
    await writeFile(join(reviewDir, 'reviewed-1.xlsx'), await decide(sheet, [
      ['Challenge 1: tracking every device in the department', DECISIONS.accept],
      ['Busy endoscopy units use many similar endoscopes during the day.', DECISIONS.reject],
    ]));

    const second = await runPipeline(configFor('second'));
    assert.equal(second.tmx.translationUnits, 2);
    assert.equal(second.review.approvedPairsUsed, 1);
    assert.equal(second.review.rows, 2, 'decided rows are not asked again');
    const tmx = await readFile(join(dir, 'second.tmx'), 'utf8');
    assert.match(tmx, /<prop type="x-origin">review<\/prop>/);
    assert.match(tmx, /Herausforderung 1: Jedes Gerät in der Abteilung nachverfolgen/);
    assert.doesNotMatch(tmx, /Ausgelastete Endoskopieabteilungen/);
  } finally {
    await site.close();
  }
});
