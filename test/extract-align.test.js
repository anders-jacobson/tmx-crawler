import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractPage } from '../src/extract.js';
import { alignBlocks, dedupeUnits } from '../src/align.js';

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

  // The looser "path" mode pairs by index only and *would* mis-pair the German-only notice:
  const loose = alignBlocks(en, de, { mode: 'path' });
  assert.equal(loose.pairs[0]?.target, 'Dieser Hinweis erscheint nur auf der deutschen Seite.');
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

test('dedupeUnits keeps the first translation and counts conflicts', () => {
  const { units, duplicates, conflicts, conflictSamples } = dedupeUnits([
    { source: 'Contact us today for details.', target: 'Kontaktieren Sie uns noch heute.', sourceUrl: 'a' },
    { source: 'Contact us today for details.', target: 'Kontaktieren Sie uns noch heute.', sourceUrl: 'b' },
    { source: 'Contact us today for details.', target: 'Nehmen Sie heute Kontakt auf.', sourceUrl: 'c' },
  ]);
  assert.equal(units.length, 1);
  assert.equal(duplicates, 1);
  assert.equal(conflicts, 1);
  assert.equal(conflictSamples[0].droppedFrom, 'c');
});
