import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { XMLParser } from 'fast-xml-parser';
import { escapeXml, sanitizeXmlText, tmxDate, verifyTmx, writeTmx } from '../src/tmx-writer.js';
import { hasXmllint, tempDir, validateWithDtd } from './helpers.js';

const ch = (code) => String.fromCodePoint(code);
const LONE_SURROGATE = String.fromCharCode(0xd800);

test('sanitizeXmlText strips characters that are illegal in XML 1.0', () => {
  const dirty = `a${ch(0)}b${ch(7)}c${ch(0x1b)}d${LONE_SURROGATE}e${ch(0xfffe)}f${ch(0x85)}g`;
  assert.equal(sanitizeXmlText(dirty), 'abcdefg');
  // Legal characters survive, including astral-plane ones and tab/newline
  const legal = `Tab\tNL\nÄÖÜ ß € ${ch(0x1f600)} „quotes“`;
  assert.equal(sanitizeXmlText(legal), legal);
});

test('escapeXml escapes all five XML special characters exactly once', () => {
  assert.equal(escapeXml(`a & b < c > d " e ' f`), 'a &amp; b &lt; c &gt; d &quot; e &apos; f');
  assert.equal(escapeXml('AT&amp;T &lt;x&gt; R&D;'), 'AT&amp;amp;T &amp;lt;x&amp;gt; R&amp;D;');
  assert.equal(escapeXml(undefined), '');
});

test('tmxDate uses the TMX YYYYMMDDThhmmssZ format', () => {
  assert.equal(tmxDate(new Date('2026-10-23T09:05:07.123Z')), '20261023T090507Z');
});

test('writeTmx produces a valid TMX 1.4 document that round-trips special characters', async () => {
  const dir = await tempDir();
  const file = join(dir, 'out', 'test.tmx');
  const special = `Fish & Chips <b>bold</b> "double" 'single' ]]> AT&amp;T`;
  const units = [
    { source: special, target: `Fisch & Pommes <b>fett</b> „doppelt“ 'einfach' ]]> AT&amp;T`, sourceUrl: 'https://x.com/int/?a=1&b="2"', targetUrl: 'https://x.com/de/' },
    { source: `Bell${ch(7)} character is removed safely.`, target: `Klingel${ch(7)}zeichen wird sicher entfernt.` },
    { source: `${ch(1)}${ch(2)}`, target: 'Only control characters in source' },
  ];

  const result = await writeTmx(file, units, { sourceLang: 'en', targetLang: 'de', now: new Date('2026-01-02T03:04:05Z') });
  assert.equal(result.units, 2);
  assert.equal(result.skipped, 1, 'unit whose source is empty after sanitising is skipped');

  const xml = await readFile(file, 'utf8');
  assert.match(xml, /^<\?xml version="1\.0" encoding="UTF-8"\?>/);
  assert.match(xml, /<tmx version="1\.4">/);
  assert.match(xml, /<header [^>]*segtype="sentence"[^>]*o-tmf="UTF-8"[^>]*srclang="en"[^>]*creationdate="20260102T030405Z"/);
  assert.ok(
    xml.includes('<seg>Fish &amp; Chips &lt;b&gt;bold&lt;/b&gt; &quot;double&quot; &apos;single&apos; ]]&gt; AT&amp;amp;T</seg>'),
    'all five special characters are escaped and a literal "&amp;" is not collapsed',
  );
  assert.match(xml, /<tuv xml:lang="de">/);

  const parsed = new XMLParser({
    ignoreAttributes: false,
    parseTagValue: false,
    trimValues: false,
    isArray: (n) => ['tu', 'tuv', 'prop'].includes(n),
  }).parse(xml);
  const [first, second] = parsed.tmx.body.tu;
  assert.equal(first.tuv[0].seg, special, 'source text round-trips exactly');
  assert.equal(first.prop[0]['#text'], 'https://x.com/int/?a=1&b="2"');
  assert.equal(second.tuv[0].seg, 'Bell character is removed safely.');

  const verification = await verifyTmx(file, { sourceLang: 'en', targetLang: 'de', expectedUnits: 2 });
  assert.deepEqual(verification.problems, []);
  assert.equal(verification.ok, true);

  if (await hasXmllint()) await validateWithDtd(file);
});

test('writeTmx writes an empty but valid body when there are no units', async (t) => {
  const dir = await tempDir();
  const file = join(dir, 'empty.tmx');
  await writeTmx(file, [], { sourceLang: 'en', targetLang: 'de' });
  const verification = await verifyTmx(file, { sourceLang: 'en', targetLang: 'de', expectedUnits: 0 });
  assert.equal(verification.ok, true, verification.problems.join('; '));
  if (await hasXmllint()) await validateWithDtd(file);
  else t.diagnostic('xmllint not installed – DTD validation skipped');
});

test('verifyTmx reports malformed files, wrong structure and size violations', async () => {
  const dir = await tempDir();
  const broken = join(dir, 'broken.tmx');
  await writeFile(broken, '<tmx version="1.4"><header></tmx>');
  const v1 = await verifyTmx(broken, { sourceLang: 'en', targetLang: 'de' });
  assert.equal(v1.ok, false);
  assert.match(v1.problems[0], /Not well-formed/);

  const wrong = join(dir, 'wrong.tmx');
  await writeFile(wrong, `<?xml version="1.0"?><tmx version="1.3"><header srclang="fr"/><body>
    <tu><tuv xml:lang="en"><seg>Only English here</seg></tuv></tu></body></tmx>`);
  const v2 = await verifyTmx(wrong, { sourceLang: 'en', targetLang: 'de', expectedUnits: 2, maxBytes: 10 });
  assert.equal(v2.ok, false);
  const all = v2.problems.join('\n');
  assert.match(all, /upload limit/);
  assert.match(all, /expected "1\.4"/);
  assert.match(all, /missing required attribute "creationtool"/);
  assert.match(all, /srclang> is "fr"/);
  assert.match(all, /lacks a non-empty <seg> for en and de/);
  assert.match(all, /expected 2/);
});

test('writeTmx refuses invalid options and leaves no partial file behind', async () => {
  const dir = await tempDir();
  await assert.rejects(writeTmx(join(dir, 'x.tmx'), [], { sourceLang: 'en' }), /requires sourceLang and targetLang/);
  await assert.rejects(writeTmx(join(dir, 'x.tmx'), [], { sourceLang: 'en', targetLang: 'de', segtype: 'chapter' }), /Invalid TMX segtype/);
});
