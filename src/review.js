/**
 * Review sheet for the part of a page the structure guard leaves out.
 *
 * When the translated page has a different layout inside a CMS block, positional pairing is not
 * trustworthy after the first difference, so those blocks never reach the TMX automatically.
 * Instead this module suggests a pairing – an order-preserving alignment of the remaining English
 * and German blocks, scored by shared words and names, numbers, length and element type – and
 * writes it to an Excel workbook. A reviewer accepts the suggestion, picks an alternative, types
 * the German, or rejects the row. Reviewed workbooks placed in the review folder are read on the
 * next run: approved pairs go into the TMX, and decided rows are not asked again.
 *
 * The .xlsx files are written and read without an Excel library (zip via fflate, XML by hand /
 * fast-xml-parser), so the tool keeps a small dependency footprint.
 */

import { readdir, readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { strToU8, strFromU8, unzipSync, zipSync } from 'fflate';
import { XMLParser } from 'fast-xml-parser';
import { countWords, normalizeText, numberFingerprint, numbersMatch, protectedTokens, stopwordsFor } from './text.js';
import { sanitizeXmlText } from './tmx-writer.js';

// --- Similarity ------------------------------------------------------------------------------

// Folds spelling differences between related words ("Kontrast"/"contrast", "Inzision"/"incision",
// "Endoskop"/"endoscope") so that a 4-letter prefix can match across English and German.
function fold(word) {
  return word.toLowerCase()
    .replace(/ä/g, 'a').replace(/ö/g, 'o').replace(/ü/g, 'u').replace(/ß/g, 'ss')
    .replace(/ph/g, 'f').replace(/th/g, 't').replace(/k/g, 'c').replace(/z/g, 'c').replace(/y/g, 'i');
}

/** Language-neutral anchors of a text: numbers, product names, and folded 4-letter word prefixes. */
export function anchorTokens(text, stopwords = new Set()) {
  const tokens = new Set(numberFingerprint(text).map((n) => `#${n}`));
  for (const token of protectedTokens(text)) tokens.add(`@${token.toLowerCase()}`);
  for (const word of text.match(/\p{L}+/gu) ?? []) {
    if (word.length < 4 || stopwords.has(word.toLowerCase())) continue;
    tokens.add(fold(word).slice(0, 4));
  }
  return tokens;
}

function dice(a, b) {
  if (!a.size || !b.size) return 0;
  let shared = 0;
  for (const token of a) if (b.has(token)) shared += 1;
  return (2 * shared) / (a.size + b.size);
}

const isHeading = (tag) => /^h[1-6]$/.test(tag);
const headingLike = (block) => isHeading(block.tag) || (countWords(block.text) <= 10 && !/[.!?]["”“»«]?$/.test(block.text));

/** German text runs ~12 % longer than English; the typical spread of the log ratio is ~0.3. */
const LENGTH_LOG_MEAN = 0.12;
const LENGTH_LOG_SPREAD = 0.3;

/**
 * Plausibility (0–1) that `tgt` translates `src`. It is meant to rank candidates against each
 * other, not as a quality score: free but correct adaptations can score low.
 */
export function pairSimilarity(src, tgt, { sourceLang, targetLang, sourceStopwords, targetStopwords } = {}) {
  const stop = new Set([...(sourceStopwords ?? stopwordsFor(sourceLang)), ...(targetStopwords ?? stopwordsFor(targetLang))]);
  const lexical = dice(anchorTokens(src.text, stop), anchorTokens(tgt.text, stop));
  const r = Math.log((tgt.text.length + 10) / (src.text.length + 10)) - LENGTH_LOG_MEAN;
  const length = Math.exp(-(r * r) / (2 * LENGTH_LOG_SPREAD ** 2));
  let tag = 0.5;
  if (src.tag === tgt.tag) tag = 1;
  else if (headingLike(src) && headingLike(tgt)) tag = 0.8;
  const srcNumbers = numberFingerprint(src.text);
  const tgtNumbers = numberFingerprint(tgt.text);
  let numbers = 0.5;
  if (srcNumbers.length || tgtNumbers.length) numbers = numbersMatch(src.text, tgt.text, sourceLang, targetLang) ? 1 : 0;
  return 0.45 * lexical + 0.25 * length + 0.1 * tag + 0.2 * numbers;
}

/**
 * Order-preserving alignment of the blocks of one drift region (Needleman–Wunsch: each English
 * block is paired with at most one German block, in page order, or left unpaired).
 * @param {{ source: object[], target: object[] }} region
 * @param {object} options
 * @param {(src: object) => boolean} options.isCandidate  English blocks worth reviewing (length etc.)
 * @param {(src: object, tgt: object) => ({ reason: string, detail: string|null }|null)} [options.checkPair]
 * @param {number} [options.threshold=0.45]  minimum similarity for a suggested pair
 * @param {number} [options.maxAlternatives=3]
 * @returns {{ source: object, suggestion: object|null, score: number, check: string|null, alternatives: object[] }[]}
 */
export function suggestPairs(region, { isCandidate = () => true, checkPair = null, threshold = 0.45, maxAlternatives = 3, sourceLang, targetLang } = {}) {
  const src = region.source;
  const tgt = region.target;
  if (!src.length || !tgt.length) return [];
  const stops = { sourceLang, targetLang, sourceStopwords: stopwordsFor(sourceLang), targetStopwords: stopwordsFor(targetLang) };
  const score = src.map((s) => tgt.map((t) => pairSimilarity(s, t, stops)));

  // dp[i][j]: best total gain aligning the first i English with the first j German blocks.
  const dp = Array.from({ length: src.length + 1 }, () => new Float64Array(tgt.length + 1));
  for (let i = 1; i <= src.length; i += 1) {
    for (let j = 1; j <= tgt.length; j += 1) {
      const gain = score[i - 1][j - 1] - threshold;
      dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1], gain > 0 ? dp[i - 1][j - 1] + gain : -Infinity);
    }
  }
  const match = new Map();
  for (let i = src.length, j = tgt.length; i > 0 && j > 0;) {
    const gain = score[i - 1][j - 1] - threshold;
    if (gain > 0 && dp[i][j] === dp[i - 1][j - 1] + gain) {
      match.set(i - 1, j - 1);
      i -= 1;
      j -= 1;
    } else if (dp[i][j] === dp[i - 1][j]) i -= 1;
    else j -= 1;
  }

  const items = [];
  src.forEach((block, i) => {
    if (!isCandidate(block)) return;
    const j = match.get(i);
    const suggestion = j === undefined ? null : tgt[j];
    const alternatives = tgt
      .map((t, k) => ({ t, k, s: score[i][k] }))
      .filter(({ k, s, t }) => k !== j && s >= 0.25 && t.text !== block.text)
      .sort((a, b) => b.s - a.s)
      .slice(0, maxAlternatives)
      .map(({ t }) => t);
    if (!suggestion && !alternatives.length) return;
    const failure = suggestion && checkPair ? checkPair(block, suggestion) : null;
    items.push({
      source: block,
      suggestion,
      score: suggestion ? score[i][j] : 0,
      check: failure ? [failure.reason, failure.detail].filter(Boolean).join(': ') : null,
      alternatives,
    });
  });
  return items;
}

export function confidenceLabel(score) {
  if (score >= 0.65) return 'High';
  if (score >= 0.5) return 'Medium';
  return score > 0 ? 'Low' : '';
}

// --- Workbook writing ------------------------------------------------------------------------

export const DECISIONS = Object.freeze({
  accept: 'Accept suggestion',
  alt1: 'Alternative 1',
  alt2: 'Alternative 2',
  alt3: 'Alternative 3',
  own: 'Use my German',
  reject: 'No match',
});

const COLUMNS = [
  { header: 'No.', width: 6 },
  { header: 'Page', width: 28 },
  { header: 'English', width: 55 },
  { header: 'Suggested German', width: 55 },
  { header: 'Match', width: 9 },
  { header: 'Decision', width: 20 },
  { header: 'Alternative 1', width: 45 },
  { header: 'Alternative 2', width: 45 },
  { header: 'Alternative 3', width: 45 },
  { header: 'Your German', width: 45 },
  { header: 'Check', width: 30 },
  { header: 'German page', width: 28 },
];

const STYLE = { normal: 0, header: 1, wrap: 2, link: 3, input: 4 };

const escapeXml = (value) => sanitizeXmlText(String(value ?? ''))
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function columnLetter(index) {
  let n = index + 1;
  let letters = '';
  while (n > 0) {
    const rem = (n - 1) % 26;
    letters = String.fromCharCode(65 + rem) + letters;
    n = Math.floor((n - 1) / 26);
  }
  return letters;
}

function textCell(ref, value, style) {
  if (value === null || value === undefined || value === '') return style ? `<c r="${ref}" s="${style}"/>` : '';
  return `<c r="${ref}" t="inlineStr" s="${style}"><is><t xml:space="preserve">${escapeXml(value)}</t></is></c>`;
}

function numberCell(ref, value, style) {
  return `<c r="${ref}" s="${style}"><v>${Number(value)}</v></c>`;
}

function linkCell(ref, url, label) {
  if (!url) return '';
  // HYPERLINK accepts at most 255 characters; longer URLs are written as plain text.
  if (url.length > 255) return textCell(ref, url, STYLE.wrap);
  const formula = `HYPERLINK("${url.replace(/"/g, '""')}","${String(label).replace(/"/g, '""')}")`;
  return `<c r="${ref}" t="str" s="${STYLE.link}"><f>${escapeXml(formula)}</f><v>${escapeXml(label)}</v></c>`;
}

function shortPath(url, base) {
  if (!url) return '';
  return base && url.startsWith(base) ? `/${url.slice(base.length)}` : url;
}

function reviewSheetXml(rows, { sourceBase, targetBase }) {
  const header = `<row r="1">${COLUMNS.map((c, i) => textCell(`${columnLetter(i)}1`, c.header, STYLE.header)).join('')}</row>`;
  const body = rows.map((row, n) => {
    const r = n + 2;
    const cells = [
      numberCell(`A${r}`, n + 1, STYLE.normal),
      linkCell(`B${r}`, row.sourceUrl, shortPath(row.sourceUrl, sourceBase)),
      textCell(`C${r}`, row.source, STYLE.wrap),
      textCell(`D${r}`, row.suggestion, STYLE.wrap),
      textCell(`E${r}`, row.confidence, STYLE.normal),
      textCell(`F${r}`, '', STYLE.input),
      textCell(`G${r}`, row.alternatives[0], STYLE.wrap),
      textCell(`H${r}`, row.alternatives[1], STYLE.wrap),
      textCell(`I${r}`, row.alternatives[2], STYLE.wrap),
      textCell(`J${r}`, '', STYLE.input),
      textCell(`K${r}`, row.check, STYLE.wrap),
      linkCell(`L${r}`, row.targetUrl, shortPath(row.targetUrl, targetBase)),
    ];
    return `<row r="${r}">${cells.join('')}</row>`;
  }).join('');
  const last = rows.length + 1;
  const list = Object.values(DECISIONS).join(',');
  return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
    + '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'
    + '<sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>'
    + '<sheetFormatPr defaultRowHeight="15"/>'
    + `<cols>${COLUMNS.map((c, i) => `<col min="${i + 1}" max="${i + 1}" width="${c.width}" customWidth="1"/>`).join('')}</cols>`
    + `<sheetData>${header}${body}</sheetData>`
    + `<autoFilter ref="A1:${columnLetter(COLUMNS.length - 1)}${last}"/>`
    + `<dataValidations count="1"><dataValidation type="list" allowBlank="1" showErrorMessage="1" errorTitle="Decision" error="Choose a value from the list." sqref="F2:F${Math.max(last, 2)}"><formula1>"${escapeXml(list)}"</formula1></dataValidation></dataValidations>`
    + '</worksheet>';
}

const INSTRUCTIONS = [
  'How to review',
  '',
  'Each row is an English text from a page where the German version has a different layout, so it could not be paired automatically.',
  '"Suggested German" is the best match found in the same part of the German page; "Match" says how sure the tool is.',
  'Open the page links to compare with the live pages when in doubt.',
  '',
  'In the Decision column choose:',
  `  ${DECISIONS.accept} – the suggested German is the translation of the English text`,
  `  ${DECISIONS.alt1} / 2 / 3 – one of the alternatives is the right German text`,
  `  ${DECISIONS.own} – write or paste the correct German in "Your German"`,
  `  ${DECISIONS.reject} – there is no German translation of this text on the page`,
  'Leave Decision empty for rows you have not reviewed yet; they will be asked again next time.',
  '',
  'Free adaptations are fine – the German pages are approved. Only check that the two texts say the same thing.',
  'When done, save the file (keep the .xlsx format) and upload it to the "review" folder of the repository.',
  'The next run adds every approved pair to the translation memory and does not ask about decided rows again.',
  '"Check" shows why an automatic check would have rejected the suggestion (e.g. differing numbers) – it is a hint, not a verdict.',
];

function instructionsSheetXml() {
  const rows = INSTRUCTIONS.map((line, i) => `<row r="${i + 1}">${textCell(`A${i + 1}`, line, i === 0 ? STYLE.header : STYLE.normal)}</row>`).join('');
  return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
    + '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'
    + '<cols><col min="1" max="1" width="140" customWidth="1"/></cols>'
    + `<sheetData>${rows}</sheetData></worksheet>`;
}

const STYLES_XML = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
  + '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'
  + '<fonts count="3"><font><sz val="11"/><name val="Calibri"/><family val="2"/></font>'
  + '<font><b/><sz val="11"/><name val="Calibri"/><family val="2"/></font>'
  + '<font><u/><sz val="11"/><color rgb="FF0563C1"/><name val="Calibri"/><family val="2"/></font></fonts>'
  + '<fills count="4"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill>'
  + '<fill><patternFill patternType="solid"><fgColor rgb="FFDDEBF7"/><bgColor indexed="64"/></patternFill></fill>'
  + '<fill><patternFill patternType="solid"><fgColor rgb="FFFFF2CC"/><bgColor indexed="64"/></patternFill></fill></fills>'
  + '<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>'
  + '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>'
  + '<cellXfs count="5">'
  + '<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0" applyAlignment="1"><alignment vertical="top"/></xf>'
  + '<xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1" applyAlignment="1"><alignment vertical="top" wrapText="1"/></xf>'
  + '<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0" applyAlignment="1"><alignment vertical="top" wrapText="1"/></xf>'
  + '<xf numFmtId="0" fontId="2" fillId="0" borderId="0" xfId="0" applyFont="1" applyAlignment="1"><alignment vertical="top"/></xf>'
  + '<xf numFmtId="0" fontId="0" fillId="3" borderId="0" xfId="0" applyFill="1" applyAlignment="1"><alignment vertical="top" wrapText="1"/></xf>'
  + '</cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>';

/**
 * Writes the review workbook (written to *.partial, then renamed).
 * @param {string} path
 * @param {{ sourceUrl: string, targetUrl: string, source: string, suggestion: string|null,
 *           confidence: string, alternatives: string[], check: string|null }[]} rows
 */
export async function writeReviewWorkbook(path, rows, { sourceBase = '', targetBase = '', title = 'TMX review', now = new Date() } = {}) {
  const xml = (body) => strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n${body}`);
  const files = {
    '[Content_Types].xml': xml('<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
      + '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
      + '<Default Extension="xml" ContentType="application/xml"/>'
      + '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>'
      + '<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>'
      + '<Override PartName="/xl/worksheets/sheet2.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>'
      + '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>'
      + '<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>'
      + '<Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>'
      + '</Types>'),
    '_rels/.rels': xml('<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
      + '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>'
      + '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>'
      + '<Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/>'
      + '</Relationships>'),
    'docProps/core.xml': xml('<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" '
      + 'xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">'
      + `<dc:title>${escapeXml(title)}</dc:title><dc:creator>site-tmx-aligner</dc:creator>`
      + `<dcterms:created xsi:type="dcterms:W3CDTF">${now.toISOString().replace(/\.\d+Z$/, 'Z')}</dcterms:created>`
      + '</cp:coreProperties>'),
    'docProps/app.xml': xml('<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties"><Application>site-tmx-aligner</Application></Properties>'),
    'xl/workbook.xml': xml('<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">'
      + '<bookViews><workbookView/></bookViews>'
      + '<sheets><sheet name="Review" sheetId="1" r:id="rId1"/><sheet name="How to review" sheetId="2" r:id="rId2"/></sheets>'
      + `<definedNames><definedName name="_xlnm._FilterDatabase" localSheetId="0" hidden="1">Review!$A$1:$${columnLetter(COLUMNS.length - 1)}$${rows.length + 1}</definedName></definedNames>`
      + '</workbook>'),
    'xl/_rels/workbook.xml.rels': xml('<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
      + '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>'
      + '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet2.xml"/>'
      + '<Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>'
      + '</Relationships>'),
    'xl/styles.xml': strToU8(STYLES_XML),
    'xl/worksheets/sheet1.xml': strToU8(reviewSheetXml(rows, { sourceBase, targetBase })),
    'xl/worksheets/sheet2.xml': strToU8(instructionsSheetXml()),
  };
  const zipped = zipSync(files, { level: 6, mtime: now });
  await mkdir(dirname(path), { recursive: true });
  await writeFile(`${path}.partial`, zipped);
  await rename(`${path}.partial`, path);
  return { path, rows: rows.length, bytes: zipped.length };
}

// --- Workbook reading ------------------------------------------------------------------------

const ARRAY_TAGS = new Set(['sheet', 'Relationship', 'si', 'r', 'row', 'c']);
const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  textNodeName: '#text',
  parseTagValue: false,
  parseAttributeValue: false,
  trimValues: false,
  htmlEntities: true, // numeric character references (&#220;) as written by some apps
  isArray: (name, _jpath, _leaf, isAttribute) => !isAttribute && ARRAY_TAGS.has(name),
});

function textOf(node) {
  if (node === undefined || node === null) return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(textOf).join('');
  if (node['#text'] !== undefined) return String(node['#text']);
  if (node.t !== undefined) return textOf(node.t);
  if (node.r !== undefined) return node.r.map((run) => textOf(run.t)).join('');
  return '';
}

function columnIndex(ref) {
  const letters = /^[A-Z]+/.exec(ref ?? '')?.[0] ?? '';
  return [...letters].reduce((n, ch) => n * 26 + (ch.charCodeAt(0) - 64), 0) - 1;
}

/** Reads the rows of the "Review" sheet (or the first sheet) as objects keyed by header text. */
export function readReviewRows(buffer) {
  const files = unzipSync(new Uint8Array(buffer));
  const read = (name) => (files[name] ? parser.parse(strFromU8(files[name])) : null);
  const workbook = read('xl/workbook.xml');
  const sheets = workbook?.workbook?.sheets?.sheet ?? [];
  const sheet = sheets.find((s) => s['@_name'] === 'Review') ?? sheets[0];
  if (!sheet) throw new Error('workbook has no sheets');
  const rels = read('xl/_rels/workbook.xml.rels')?.Relationships?.Relationship ?? [];
  const rel = rels.find((r) => r['@_Id'] === sheet['@_r:id']);
  const target = String(rel?.['@_Target'] ?? 'worksheets/sheet1.xml').replace(/^\/?xl\//, '').replace(/^\//, '');
  const shared = (read('xl/sharedStrings.xml')?.sst?.si ?? []).map(textOf);
  const rows = read(`xl/${target}`)?.worksheet?.sheetData?.row ?? [];

  const cellValue = (c) => {
    const type = c['@_t'];
    if (type === 's') return shared[Number(textOf(c.v))] ?? '';
    if (type === 'inlineStr') return textOf(c.is);
    return textOf(c.v);
  };
  const grid = rows.map((row) => {
    const values = [];
    for (const c of row.c ?? []) {
      const index = columnIndex(c['@_r']);
      values[index >= 0 ? index : values.length] = { value: cellValue(c), formula: textOf(c.f) };
    }
    return values;
  });
  const [headerRow = [], ...dataRows] = grid;
  const headers = headerRow.map((cell) => normalizeText(cell?.value ?? ''));
  return dataRows.map((cells) => Object.fromEntries(headers.map((h, i) => [h, cells[i] ?? { value: '', formula: '' }]).filter(([h]) => h)));
}

const urlFromCell = (cell) => /HYPERLINK\(\s*"([^"]+)"/i.exec(cell?.formula ?? '')?.[1] ?? null;

/**
 * Turns reviewed rows into decisions.
 * @returns {{ approved: { source: string, target: string, sourceUrl: string|null, targetUrl: string|null }[],
 *            decided: Set<string>, rejected: number, invalid: { row: number, reason: string }[] }}
 */
export function decisionsFromRows(rows) {
  const approved = [];
  const decided = new Set();
  const invalid = [];
  let rejected = 0;
  const choices = {
    [DECISIONS.accept.toLowerCase()]: 'Suggested German',
    [DECISIONS.alt1.toLowerCase()]: 'Alternative 1',
    [DECISIONS.alt2.toLowerCase()]: 'Alternative 2',
    [DECISIONS.alt3.toLowerCase()]: 'Alternative 3',
    [DECISIONS.own.toLowerCase()]: 'Your German',
  };
  rows.forEach((row, i) => {
    const decision = normalizeText(row.Decision?.value ?? '').toLowerCase();
    const source = normalizeText(row.English?.value ?? '');
    if (!decision || !source) return;
    if (decision === DECISIONS.reject.toLowerCase()) {
      decided.add(source);
      rejected += 1;
      return;
    }
    const column = choices[decision];
    const target = column ? normalizeText(row[column]?.value ?? '') : '';
    if (!column || !target) {
      invalid.push({ row: i + 2, reason: column ? `"${column}" is empty` : `unknown decision "${row.Decision?.value}"` });
      return;
    }
    decided.add(source);
    approved.push({ source, target, sourceUrl: urlFromCell(row.Page), targetUrl: urlFromCell(row['German page']) });
  });
  return { approved, decided, rejected, invalid };
}

/**
 * Reads every reviewed workbook (*.xlsx) in `dir`. A missing folder means nothing was reviewed yet.
 * Later files win when the same English text was decided twice (files are read in name order).
 */
export async function readReviewFolder(dir) {
  const result = { files: [], approved: [], decided: new Set(), rejected: 0, invalid: [] };
  let names;
  try {
    names = (await readdir(dir)).filter((n) => /\.xlsx$/i.test(n) && !n.startsWith('~$')).sort();
  } catch (error) {
    if (error.code === 'ENOENT') return result;
    throw error;
  }
  const bySource = new Map();
  for (const name of names) {
    const path = join(dir, name);
    let decisions;
    try {
      decisions = decisionsFromRows(readReviewRows(await readFile(path)));
    } catch (error) {
      throw new Error(`Cannot read review file "${path}": ${error.message}`, { cause: error });
    }
    result.files.push(name);
    for (const pair of decisions.approved) bySource.set(pair.source, pair);
    for (const source of decisions.decided) {
      result.decided.add(source);
      if (!decisions.approved.some((p) => p.source === source)) bySource.delete(source);
    }
    result.rejected += decisions.rejected;
    result.invalid.push(...decisions.invalid.map((x) => ({ file: name, ...x })));
  }
  result.approved = [...bySource.values()];
  return result;
}
