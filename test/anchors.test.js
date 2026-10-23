/**
 * Anchor-based alignment on markup modelled after an Optimizely/EPiServer site: hero banner
 * outside <main>, every content block carrying a CMS id that is identical in all languages,
 * blocks re-ordered or added on the translated page, and list items in a different order.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractPage } from '../src/extract.js';
import { alignBlocks } from '../src/align.js';
import { missingProtectedTokens, protectedTokens, readsAsSourceLanguage } from '../src/text.js';

const OPTIONS = {
  contentRoot: '.Banner-main, main#Main',
  anchorSelector: '[id^="block-"]',
  noiseSelectors: ['nav', 'footer', '.TeaserSlider-nav', '[id^="block-"]:has(.NewsListBlock-wrapper)'],
};

const page = (lang, hero, blocks) => `<!doctype html><html lang="${lang}"><body>
  <nav><ul><li><a href="/x/">Navigation entry that is long enough</a></li></ul></nav>
  <div class="Banner-main"><div id="block-900" class="Banner"><h1>${hero}</h1></div></div>
  <main id="Main" class="Main"><div class="Page-wrapper"><div>${blocks.join('\n')}</div></div></main>
  <footer><p>Global footer text that must never be aligned anywhere.</p></footer>
</body></html>`;

const EN = page('en', 'Hemodynamic monitoring at the highest level', [
  `<div id="block-1" class="Column"><h2>Two physical principles combined</h2>
     <p>The technology combines pulse contour analysis with transpulmonary thermodilution.</p></div>`,
  `<div id="block-2" class="Ingress"><ul>
     <li>Extracorporeal Membrane Oxygenation (ECMO)</li>
     <li>Mechanical circulatory support (IABP)</li>
     <li>Servo-u ventilator for adult patients</li></ul></div>`,
  `<div id="block-3" class="BlockMargin"><div class="NewsListBlock-wrapper">
     <p>Interim report for the third quarter is now published.</p></div></div>`,
  `<div id="block-4" class="Column"><h2>Ethics and sustainability matter</h2>
     <p>Our sustainability work is an integral part of what we do.</p></div>`,
  `<div class="TeaserSlider-nav"><h3>Ethics and sustainability matter</h3></div>`,
]);

// German page: block-4 moved to the top, an extra German-only block, list items re-ordered,
// and one paragraph left in English (untranslated fallback).
const DE = page('de', 'Hämodynamisches Monitoring auf höchstem Niveau', [
  `<div id="block-4" class="Column"><h2>Ethik und Nachhaltigkeit zählen</h2>
     <p>Unsere Nachhaltigkeitsarbeit ist ein wesentlicher Bestandteil unserer Arbeit.</p></div>`,
  `<div id="block-77" class="Column"><h2>Wie können wir Ihnen weiterhelfen?</h2>
     <p>Bitte nehmen Sie Kontakt zu unserem Vertrieb in Deutschland auf.</p></div>`,
  `<div id="block-1" class="Column"><h2>Zwei physikalische Prinzipien kombiniert</h2>
     <p>The technology combines pulse contour analysis with thermodilution for every patient.</p></div>`,
  `<div id="block-2" class="Ingress"><ul>
     <li>Extrakorporale Membranoxygenierung (ECMO)</li>
     <li>Beatmungsgerät Servo-n für Neugeborene</li>
     <li>Erweitertes Patientenmonitoring auf der Intensivstation</li></ul></div>`,
  `<div id="block-3" class="BlockMargin"><div class="NewsListBlock-wrapper">
     <p>Der Bericht für das zweite Quartal ist jetzt veröffentlicht.</p></div></div>`,
]);

test('blocks are scoped by CMS anchor id and the hero outside <main> is included', () => {
  const { blocks } = extractPage(EN, OPTIONS);
  assert.deepEqual(blocks.map((b) => `${b.scope} ${b.text}`), [
    'block-900 Hemodynamic monitoring at the highest level',
    'block-1 Two physical principles combined',
    'block-1 The technology combines pulse contour analysis with transpulmonary thermodilution.',
    'block-2 Extracorporeal Membrane Oxygenation (ECMO)',
    'block-2 Mechanical circulatory support (IABP)',
    'block-2 Servo-u ventilator for adult patients',
    'block-4 Ethics and sustainability matter',
    'block-4 Our sustainability work is an integral part of what we do.',
  ]);
  assert.equal(blocks[2].strictPath, 'p[0:1]');
});

test('anchored alignment pairs block-to-block regardless of order and rejects unsafe pairs', () => {
  const en = extractPage(EN, OPTIONS).blocks;
  const de = extractPage(DE, OPTIONS).blocks;
  const { pairs, stats } = alignBlocks(en, de, { mode: 'strict', sourceLang: 'en', targetLang: 'de' });

  assert.deepEqual(pairs.map((p) => [p.source, p.target]), [
    ['Hemodynamic monitoring at the highest level', 'Hämodynamisches Monitoring auf höchstem Niveau'],
    ['Two physical principles combined', 'Zwei physikalische Prinzipien kombiniert'],
    ['Extracorporeal Membrane Oxygenation (ECMO)', 'Extrakorporale Membranoxygenierung (ECMO)'],
    ['Ethics and sustainability matter', 'Ethik und Nachhaltigkeit zählen'],
    ['Our sustainability work is an integral part of what we do.', 'Unsere Nachhaltigkeitsarbeit ist ein wesentlicher Bestandteil unserer Arbeit.'],
  ]);
  assert.deepEqual(stats.rejected, {
    'wrong-language': 1, // English paragraph left on the German page
    'protected-token-mismatch': 2, // (IABP) and Servo-u list items in a different order
  });
  assert.ok(!pairs.some((p) => /Kontakt|Quartal|Navigation|footer/i.test(p.target)), 'German-only and news blocks never pair');
});

test('a block id used twice on one page gets a distinct scope', () => {
  const html = `<main><div id="block-5"><p>First use of the shared block text.</p></div>
    <div id="block-5"><p>Second use of the shared block text.</p></div></main>`;
  const { blocks } = extractPage(html, { anchorSelector: '[id^="block-"]' });
  assert.deepEqual(blocks.map((b) => b.scope), ['block-5', 'block-5#2']);
});

test('without an anchor selector the root index is the scope (backwards compatible)', () => {
  const { blocks } = extractPage('<main><p>Plain paragraph without anchors here.</p></main>');
  assert.equal(blocks[0].scope, '@0');
});

test('protected tokens: brand names, model names and parenthesised acronyms', () => {
  assert.deepEqual(protectedTokens('The PiCCO Module for PulsioFlex supports Servo-u and (IABP) in the ICU'),
    ['PiCCO', 'PulsioFlex', 'Servo-u', 'IABP']);
  assert.deepEqual(protectedTokens('Follow-up care for adult patients'), [], 'ordinary hyphenated words are not protected');
  assert.deepEqual(missingProtectedTokens('Full functionality for IntelliVue', 'Volle Funktionalität für IntelliVue'), []);
  assert.deepEqual(missingProtectedTokens('Servo-u MR Conditional Ventilator', 'Beatmungsgerät Servo-n für Neugeborene'), ['Servo-u']);
  assert.deepEqual(missingProtectedTokens('Monitoring with picco', 'Monitoring mit PICCO'), [], 'comparison is case-insensitive');
});

test('readsAsSourceLanguage detects untranslated fallback text', () => {
  assert.ok(readsAsSourceLanguage('The pandemic has created a unique challenge for the healthcare sector', 'en', 'de'));
  assert.ok(!readsAsSourceLanguage('Das Modul ist eine Erweiterung des Monitors', 'en', 'de'));
  assert.ok(!readsAsSourceLanguage('Digitale Services über FleetView', 'en', 'de'), 'too few function words to judge');
  assert.ok(!readsAsSourceLanguage('The text is English', 'en', 'xx'), 'unknown languages never trigger');
});

test('collapsed accordion panels (hidden attribute) are kept as page content', () => {
  const html = `<main><div id="block-8"><button aria-hidden="true">Toggle</button>
    <div class="Accordion-panel" hidden><p>Clinical evidence summary for the monitoring technology.</p></div></div></main>`;
  const { blocks } = extractPage(html, { anchorSelector: '[id^="block-"]' });
  assert.deepEqual(blocks.map((b) => b.text), ['Clinical evidence summary for the monitoring technology.']);
});
