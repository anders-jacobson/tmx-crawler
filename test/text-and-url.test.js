import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  countWords,
  isUntranslated,
  normalizeText,
  numberFingerprint,
  numbersMatch,
  numberWordValues,
  protectedTokens,
  readsAsSourceLanguage,
} from '../src/text.js';
import { alignBlocks } from '../src/align.js';
import {
  hreflangMatches,
  isSameDocument,
  isUnderBase,
  mapByBase,
  normalizeBaseUrl,
  normalizeUrl,
  passesFilters,
  compilePatterns,
} from '../src/url-utils.js';

const NBSP = String.fromCharCode(0xa0);
const SOFT_HYPHEN = String.fromCharCode(0xad);
const ZWSP = String.fromCharCode(0x200b);

test('normalizeText collapses whitespace and strips invisible characters', () => {
  assert.equal(normalizeText(`  Medizin${SOFT_HYPHEN}technik\n\t und${NBSP}mehr${ZWSP}  `), 'Medizintechnik und mehr');
  assert.equal(normalizeText(undefined), '');
});

test('countWords', () => {
  assert.equal(countWords('one two  three\nfour'), 4);
  assert.equal(countWords('   '), 0);
});

test('numberFingerprint is locale-agnostic', () => {
  assert.deepEqual(numberFingerprint('More than 10,000 staff since 1904'), ['10000', '1904']);
  assert.deepEqual(numberFingerprint('Mehr als 10.000 Mitarbeitende seit 1904'), ['10000', '1904']);
  assert.ok(numbersMatch('Price 1,000.50 EUR', 'Preis 1.000,50 EUR'));
  assert.ok(!numbersMatch('25 sites', '26 Standorte'));
  assert.ok(numbersMatch('No numbers here', 'Keine Zahlen hier'));
});

test('isUntranslated is case-insensitive', () => {
  assert.ok(isUntranslated('Servo-air Lite', 'servo-air lite'));
  assert.ok(!isUntranslated('Contact us', 'Kontakt'));
});

test('normalizeUrl canonicalises and rejects non-http URLs', () => {
  assert.equal(normalizeUrl('/int/a/?utm_source=x#top', { base: 'https://example.com/int/' }), 'https://example.com/int/a/');
  assert.equal(
    normalizeUrl('https://example.com/a?b=2&utm_medium=x&a=1', { dropQuery: false }),
    'https://example.com/a?a=1&b=2',
  );
  assert.equal(normalizeUrl('mailto:x@example.com'), null);
  assert.equal(normalizeUrl('javascript:void(0)'), null);
  assert.equal(normalizeUrl('not a url'), null);
});

test('base URL scoping and structural mapping', () => {
  const src = normalizeBaseUrl('https://www.getinge.com/int');
  const tgt = normalizeBaseUrl('https://www.getinge.com/de/');
  assert.equal(src, 'https://www.getinge.com/int/');
  assert.ok(isUnderBase('https://www.getinge.com/int/products/x/', src));
  assert.ok(isUnderBase('https://www.getinge.com/int', src));
  assert.ok(!isUnderBase('https://www.getinge.com/international/', src));
  assert.equal(mapByBase('https://www.getinge.com/int/products/x/', src, tgt), 'https://www.getinge.com/de/products/x/');
  assert.equal(mapByBase('https://www.getinge.com/us/x/', src, tgt), null);
  // Cross-host mirroring works the same way
  assert.equal(mapByBase('https://en.example.com/a/b', 'https://en.example.com/', 'https://de.example.com/'), 'https://de.example.com/a/b');
});

test('isSameDocument ignores trailing slash and path case', () => {
  assert.ok(isSameDocument('https://x.com/de/About/', 'https://x.com/de/about'));
  assert.ok(!isSameDocument('https://x.com/de/', 'https://x.com/de/about/'));
});

test('hreflang matching', () => {
  assert.ok(hreflangMatches('de-DE', 'de'));
  assert.ok(hreflangMatches('de', 'de-DE'));
  assert.ok(hreflangMatches('DE', 'de'));
  assert.ok(!hreflangMatches('x-default', 'de'));
  assert.ok(!hreflangMatches('en', 'de'));
});

test('include/exclude filters', () => {
  const filters = { include: compilePatterns(['/products/']), exclude: compilePatterns(['\\.pdf$']) };
  assert.ok(passesFilters('https://x.com/int/products/a/', filters));
  assert.ok(!passesFilters('https://x.com/int/products/a.pdf', filters));
  assert.ok(!passesFilters('https://x.com/int/company/', filters));
  assert.throws(() => compilePatterns(['(']), /Invalid pattern regular expression/);
});

// --- Fixes derived from the 30-page Getinge evaluation ------------------------------------------

const pairOf = (en, de) => {
  const block = (text) => [{ index: 0, tag: 'p', scope: 'b', path: 'p[0]', strictPath: 'p[0:1]', text }];
  return alignBlocks(block(en), block(de), { sourceLang: 'en', targetLang: 'de' });
};

test('numbers written as words reconcile with digits, but words alone never cause a mismatch', () => {
  assert.deepEqual([...numberWordValues('innerhalb von zwei oder drei Werktagen', 'de')], ['2', '3']);
  assert.deepEqual([...numberWordValues('one of the two modes', 'en')], ['2'], '"one" is ignored on purpose');
  assert.ok(numbersMatch('typically within 2 or 3 business days', 'in der Regel innerhalb von zwei oder drei Werktagen', 'en', 'de'));
  assert.ok(numbersMatch('the two modes complement each other', 'die beiden Modi ergänzen sich', 'en', 'de'));
  assert.ok(!numbersMatch('Management of the Neonate', '12. Forum für Atmungstherapie', 'en', 'de'));
  assert.ok(!numbersMatch('We operate 25 sites', 'Wir betreiben zwei Standorte', 'en', 'de'));
  assert.equal(pairOf(
    'Our teams aim to respond to inquiries as quickly as possible, typically within 2 or 3 business days.',
    'Unsere Teams bemühen sich, Anfragen so schnell wie möglich zu beantworten, in der Regel innerhalb von zwei oder drei Werktagen.',
  ).pairs.length, 1);
});

test('uppercase hyphenated product names must carry over (T-DOC)', () => {
  assert.deepEqual(protectedTokens('Read more about T-DOC and VV-ECMO, not COVID-19'), ['T-DOC', 'VV-ECMO']);
  const { stats } = pairOf('Read more about T-DOC', 'Weiterlesen');
  assert.equal(stats.rejected['protected-token-mismatch'], 1);
  assert.equal(pairOf('Read more about T-DOC', 'Erfahren Sie mehr über T-DOC').pairs.length, 1);
});

test('English titles kept inside a German sentence do not trip the language check', () => {
  const source = 'From Culture to Cure - Watch the film';
  assert.ok(!readsAsSourceLanguage('From Culture to Cure – Film ansehen', 'en', 'de', source));
  assert.ok(readsAsSourceLanguage('From Culture to Cure – Film ansehen', 'en', 'de'), 'without the source the title still counts');
  // Real English fallback text is still caught, even when it shares words with the source …
  assert.ok(readsAsSourceLanguage(
    'As the building block to living organisms, cells make up our bodies and perform many functions',
    'en', 'de', 'One of the major technologies introduced to the biotech industry in recent years',
  ));
  // … and so is lightly edited English (not title-like, so nothing is excused).
  assert.ok(readsAsSourceLanguage(
    'Learn how to prime the circuit step by step before therapy', 'en', 'de',
    'Learn how to prime the circuit before starting therapy',
  ));
});
