import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractPage } from '../src/extract.js';
import { alignBlocks, compareLayouts, dedupeUnits } from '../src/align.js';

const page = (lang, main, extra = '') => `<!doctype html><html lang="${lang}"><head>
  <title>T</title><link rel="alternate" hreflang="de" href="/de/x/"></head><body>
  <div class="cookie-banner"><p>We use cookies on this website to improve it.</p></div>
  <nav><a href="/int/a/">A</a></nav>
  <div class="country-selector"><p>Choose your country and language here please.</p></div>
  ${extra}
  <main>${main}</main>
  <footer><p>All rights reserved by the company and its subsidiaries.</p></footer>
</body></html>`;

test('extractPage strips chrome, keeps innermost blocks, harvests links before stripping', () => {
  const html = page('en', `
    <h1>Main heading of the page</h1>
    <ul><li><p>Paragraph inside a list item here.</p></li><li>Plain list item with text</li></ul>
    <p>Line one<br>line two of the same paragraph.</p>
    <div class="card"><li><div>Title text</div><div>Body text of card</div></li></div>
    <script>var x = "<p>not text</p>";</script>`);
  const result = extractPage(html, { baseUrl: 'https://example.com/int/x/' });

  assert.equal(result.lang, 'en');
  assert.deepEqual(result.alternates, [{ hreflang: 'de', href: '/de/x/' }]);
  assert.ok(result.links.includes('/int/a/'), 'links inside <nav> are harvested');

  const texts = result.blocks.map((b) => b.text);
  assert.deepEqual(texts, [
    'Main heading of the page',
    'Paragraph inside a list item here.',
    'Plain list item with text',
    'Line one line two of the same paragraph.',
    'Title text Body text of card',
  ]);
  assert.ok(!texts.some((t) => /cookies|country|rights reserved|not text/.test(t)));
  assert.equal(result.blocks[1].tag, 'p');
  assert.equal(result.blocks[1].path, 'ul[0]/li[0]/p[0]');
  assert.equal(result.blocks[1].strictPath, 'ul[0:1]/li[0:2]/p[0:1]');
});

test('dynamic widgets remove their whole containing block', () => {
  const html = page('en', `
    <p>Starts in <span class="countdown">3 days</span> at the venue.</p>
    <p>Updated <time datetime="2026-10-23">today</time> by the editorial team.</p>
    <p>A perfectly static paragraph of text.</p>`);
  const texts = extractPage(html).blocks.map((b) => b.text);
  assert.deepEqual(texts, ['A perfectly static paragraph of text.']);
});

test('falls back to <body> when no content root exists, and tolerates invalid selectors', () => {
  const html = '<html><body><div><p>Text without any main element here.</p></div></body></html>';
  const invalid = [];
  const result = extractPage(html, {
    noiseSelectors: ['[[[invalid'],
    onInvalidSelector: (selector) => invalid.push(selector),
  });
  assert.equal(result.blocks.length, 1);
  assert.deepEqual(invalid, ['[[[invalid']);
});

const blocksOf = (lang, main) => extractPage(page(lang, main)).blocks;

test('strict alignment never pairs across a structural shift', () => {
  const en = blocksOf('en', `
    <section><h2>Intensive care ventilation solutions</h2><p>Ventilators for adults, children and neonates in care.</p></section>`);
  const de = blocksOf('de', `
    <section><p>Dieser Hinweis erscheint nur auf der deutschen Seite.</p></section>
    <section><h2>Beatmungslösungen für die Intensivpflege</h2><p>Beatmungsgeräte für Erwachsene, Kinder und Neugeborene.</p></section>`);

  const strict = alignBlocks(en, de, { mode: 'strict' });
  assert.equal(strict.pairs.length, 0);
  assert.equal(strict.stats.rejected['no-structural-match'], 2);

  // The looser "path" mode pairs by index only and *would* mis-pair the German-only notice …
  const loose = alignBlocks(en, de, { mode: 'path', structureGuard: 'off' });
  assert.equal(loose.pairs[0]?.target, 'Dieser Hinweis erscheint nur auf der deutschen Seite.');
  // … unless the structure guard is on (the default).
  assert.equal(alignBlocks(en, de, { mode: 'path' }).pairs.length, 0);
});

const anchoredBlocksOf = (lang, main) => extractPage(page(lang, main), { anchors: [{ selector: '[id^="block-"]' }] }).blocks;

test('structure guard: equal per-tag counts in a different order drop the drifted part of the block', () => {
  // German turns the bold "Challenge" paragraph into a heading and adds a paragraph further down –
  // the number of <p> stays the same, so strict paths alone would pair every paragraph one off.
  const en = anchoredBlocksOf('en', `<div id="block-1">
    <h2>Why endoscopes are different</h2>
    <p>Endoscopes are reprocessed many times every single day.</p>
    <p>Challenge 1: keeping track of every device</p>
    <p>Busy units use many similar endoscopes during a day.</p>
    <p>This level of traceability is particularly important here.</p></div>
    <div id="block-2"><h2>Summary of the article</h2><p>Complete information helps every department.</p></div>`);
  const de = anchoredBlocksOf('de', `<div id="block-1">
    <h2>Warum Endoskope anders sind</h2>
    <p>Endoskope werden jeden Tag viele Male aufbereitet.</p>
    <h3>Herausforderung 1: Den Überblick über jedes Gerät behalten</h3>
    <p>In ausgelasteten Abteilungen werden viele ähnliche Endoskope genutzt.</p>
    <p>Diese Rückverfolgbarkeit ist hier besonders wichtig.</p>
    <p>Mitarbeitende benötigen daher klare Anweisungen.</p></div>
    <div id="block-2"><h2>Zusammenfassung des Artikels</h2><p>Vollständige Informationen helfen jeder Abteilung.</p></div>`);
  const options = { mode: 'strict', minWordsByTag: { h2: 1, h3: 1 } };
  // Default "prefix": the heading before the difference survives; the paragraph right before it
  // does not (an inserted paragraph there would be invisible), nor does anything after it.
  const guarded = alignBlocks(en, de, options);
  assert.equal(guarded.stats.rejected['structure-drift'], 4, JSON.stringify(guarded.stats.rejected));
  assert.deepEqual(guarded.pairs.map((p) => p.target), [
    'Warum Endoskope anders sind', 'Zusammenfassung des Artikels', 'Vollständige Informationen helfen jeder Abteilung.',
  ]);
  const drift = guarded.rejectedPairs.find((r) => r.reason === 'structure-drift');
  assert.match(drift.detail, /position 3 \(p vs h3; 5 vs 6 blocks\); 1 leading block\(s\) kept/);
  assert.equal(drift.tag, 'p');

  const scope = alignBlocks(en, de, { ...options, structureGuard: 'scope' });
  assert.deepEqual(scope.pairs.map((p) => p.target), ['Zusammenfassung des Artikels', 'Vollständige Informationen helfen jeder Abteilung.']);
  assert.throws(() => alignBlocks(en, de, { ...options, structureGuard: 'maybe' }), /structure guard/);

  const unguarded = alignBlocks(en, de, { ...options, structureGuard: 'off' });
  assert.ok(unguarded.pairs.some((p) => p.source.startsWith('Busy units') && p.target.startsWith('Diese Rückverfolgbarkeit')),
    'without the guard the paragraphs slide by one');
});

test('compareLayouts finds the divergence and the safe prefix', () => {
  const t = (s) => s.split(' ');
  assert.deepEqual(compareLayouts(t('h2 p p li li'), t('h2 p p li li')), { same: true, diverge: 5, safe: 5 });
  // Rewritten section end (OR lighting article): heading kept, paragraph before the divergence dropped.
  assert.deepEqual(compareLayouts(t('p h2 p p li li p p'), t('p h2 p li li p p p')), { same: false, diverge: 3, safe: 2 });
  // German adds a closing paragraph: everything before it is safe.
  assert.deepEqual(compareLayouts(t('h2 p li li'), t('h2 p li li p')), { same: false, diverge: 4, safe: 4 });
  assert.deepEqual(compareLayouts(t('h2 p'), t('h2')), { same: false, diverge: 1, safe: 1 });
  assert.deepEqual(compareLayouts(t('p p p'), t('p p p p')), { same: false, diverge: 3, safe: 0 });
});

test('placeholder text, suppression list and acronym equivalents', () => {
  const en = blocksOf('en', `
    <p>A new study shows that few hospitals use available AI technology.</p>
    <p>ISOPRIME isolator for sterility testing</p>
    <p>Optimize the Central Sterile Supply Department (CSSD) workflow.</p>
    <p>Use artificial intelligence (AI) to plan the day.</p>`);
  const de = blocksOf('de', `
    <p>Å ŉęŵ şŧūđy şĥőŵş ŧĥäŧ ƒęŵ ĥőşpįŧäľş ūşę äväįľäþľę ÅĨ ŧęčĥŉőľőģy.</p>
    <p>Lösungen für Sterilitätstests</p>
    <p>Optimieren Sie die Abläufe der Aufbereitungseinheit für Medizinprodukte (AEMP).</p>
    <p>Planen Sie den Tag mit künstlicher Intelligenz.</p>`);
  const base = { mode: 'strict', sourceLang: 'en', targetLang: 'de', requireNumberMatch: false };
  const withoutEquivalents = alignBlocks(en, de, base);
  assert.equal(withoutEquivalents.stats.rejected['unexpected-characters'], 1);
  assert.equal(withoutEquivalents.stats.rejected['protected-token-mismatch'], 2);

  const result = alignBlocks(en, de, {
    ...base,
    tokenEquivalents: { de: { CSSD: ['AEMP', 'ZSVA'], AI: ['KI'] } },
    suppressPairs: [{ source: 'ISOPRIME isolator for sterility testing', target: 'Lösungen für Sterilitätstests' }],
  });
  assert.equal(result.stats.rejected.suppressed, 1);
  assert.equal(result.stats.rejected['unexpected-characters'], 1);
  // CSSD → AEMP is accepted; "AI" is still missing because the German says neither AI nor KI.
  assert.deepEqual(result.pairs.map((p) => p.target), ['Optimieren Sie die Abläufe der Aufbereitungseinheit für Medizinprodukte (AEMP).']);
  assert.equal(result.stats.rejected['protected-token-mismatch'], 1);
});

test('quality gates: word range, untranslated, length ratio, numbers', () => {
  const en = blocksOf('en', `
    <p>Read more</p>
    <p>Servo-air Lite NIV ventilator family</p>
    <p>A short sentence with five words.</p>
    <p>We operate 25 production sites worldwide.</p>
    <p>Founded in 1904, we employ 10,000 people.</p>`);
  const de = blocksOf('de', `
    <p>Mehr lesen</p>
    <p>Servo-air Lite NIV ventilator family</p>
    <p>Dies ist ein sehr viel längerer deutscher Satz, der eindeutig nicht dieselbe Bedeutung hat und viel zu lang ist.</p>
    <p>Wir betreiben 26 Produktionsstätten weltweit.</p>
    <p>Seit 1904 beschäftigen wir 10.000 Menschen.</p>`);

  const { pairs, stats } = alignBlocks(en, de, { mode: 'strict', minWords: 4, maxWords: 80 });
  assert.deepEqual(stats.rejected, { 'word-range': 1, untranslated: 1, 'length-ratio': 1, 'number-mismatch': 1 });
  assert.deepEqual(pairs.map((p) => p.target), ['Seit 1904 beschäftigen wir 10.000 Menschen.']);
});

test('sequence mode requires identical block counts', () => {
  const en = blocksOf('en', '<p>First paragraph with words.</p><p>Second paragraph with words.</p>');
  const de = blocksOf('de', '<p>Erster Absatz mit Wörtern.</p>');
  const result = alignBlocks(en, de, { mode: 'sequence' });
  assert.equal(result.pairs.length, 0);
  assert.equal(result.stats.rejected['block-count-mismatch'], 2);
});

test('dedupeUnits: majority wins, similar ties keep the first, divergent ties are dropped', () => {
  const u = (source, target, sourceUrl) => ({ source, target, sourceUrl });
  const input = [
    u('Contact us today for details.', 'Nehmen Sie heute Kontakt auf.', 'a'),
    u('Contact us today for details.', 'Kontaktieren Sie uns noch heute.', 'b'),
    u('Contact us today for details.', 'Kontaktieren Sie uns noch heute.', 'c'),
    u('Access – right to request information.', 'Auskunftsrecht – Recht, Informationen anzufordern.', 'd'),
    u('Access – right to request information.', 'Auskunftsrecht – Recht, Informationen zu verlangen.', 'e'),
    u('To support our customers we use remote FAT.', 'Eine Werksabnahme ist ein wichtiger Schritt für Qualität.', 'f'),
    u('To support our customers we use remote FAT.', 'Zur Unterstützung unserer Kunden nutzen wir Remote FAT.', 'g'),
    u('Unique sentence.', 'Einzigartiger Satz.', 'h'),
  ];
  const { units, duplicates, conflicts, divergentDropped, conflictSamples } = dedupeUnits(input);
  assert.deepEqual(units.map((x) => x.sourceUrl), ['b', 'd', 'h']);
  assert.equal(units.length + duplicates + conflicts, input.length, 'every occurrence is accounted for');
  assert.equal(divergentDropped, 1);
  assert.deepEqual(conflictSamples.map((s) => s.resolution), ['divergent-dropped', 'majority', 'similar-variants']);
  assert.equal(conflictSamples[0].kept, null);
  assert.equal(conflictSamples[1].variants.find((v) => v.from === 'b').count, 2);
});
