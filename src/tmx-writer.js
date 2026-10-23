/**
 * TMX 1.4 writer (streaming, via xmlbuilder2's callback API) and post-write verifier.
 *
 * Escaping, in three layers:
 *  1. sanitizeXmlText() removes characters that XML 1.0 forbids (control characters, lone UTF-16
 *     surrogates, U+FFFE/U+FFFF) - these are what make strict XML parsers reject a file.
 *  2. escapeXml() explicitly converts all five special characters & < > " ' to entity references.
 *     This is required, not cosmetic: xmlbuilder2 deliberately leaves text that already *looks*
 *     like an entity (e.g. the literal string "AT&amp;T") untouched, which would silently turn it
 *     into "AT&T" on import. Pre-escaping every "&" makes the round trip exact.
 *  3. The serializer runs with wellFormed: true, and the finished file is re-parsed by verifyTmx().
 */

import { createWriteStream } from 'node:fs';
import { mkdir, readFile, rename, rm, stat } from 'node:fs/promises';
import { once } from 'node:events';
import { dirname } from 'node:path';
import { createCB } from 'xmlbuilder2';
import { XMLParser, XMLValidator } from 'fast-xml-parser';

const XML_NS = 'http://www.w3.org/XML/1998/namespace';

/** DeepL's documented upload ceiling for TMX files (1 GB, decimal – the conservative reading). */
export const DEEPL_MAX_TMX_BYTES = 1_000_000_000;

export const TMX_SEGTYPES = Object.freeze(['block', 'paragraph', 'sentence', 'phrase']);
const REQUIRED_HEADER_ATTRIBUTES = [
  'creationtool', 'creationtoolversion', 'segtype', 'o-tmf', 'adminlang', 'srclang', 'datatype',
];

// Anything outside the XML 1.0 "Char" production, plus C1 control characters (legal but
// discouraged, and never meaningful in web copy).
const INVALID_XML_CHARS = /[^\t\n\r\u0020-\u007E\u00A0-\uD7FF\uE000-\uFFFD\u{10000}-\u{10FFFF}]/gu;

/**
 * Removes characters that are not allowed (or strongly discouraged) in XML 1.0 documents.
 * @param {unknown} value
 * @returns {string}
 */
export function sanitizeXmlText(value) {
  return String(value ?? '').replace(INVALID_XML_CHARS, '');
}

const XML_ENTITIES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' };

/**
 * Escapes the five XML special characters. The output only contains the predefined entity
 * references, which xmlbuilder2 passes through verbatim (so nothing is double-escaped).
 * @param {unknown} value
 * @returns {string}
 */
export function escapeXml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (char) => XML_ENTITIES[char]);
}

/** Sanitise + escape: the only form in which external text is handed to the serializer. */
const xmlText = (value) => escapeXml(sanitizeXmlText(value));

/** TMX date format: YYYYMMDDThhmmssZ (UTC). */
export function tmxDate(date = new Date()) {
  return date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
}

/**
 * Streams a TMX 1.4 document to disk. Writes to "<file>.partial" first and renames on success,
 * so an interrupted run never leaves a truncated .tmx behind.
 *
 * @param {string} filePath
 * @param {{ source: string, target: string, sourceUrl?: string, targetUrl?: string }[]} units
 * @param {object} options
 * @param {string} options.sourceLang
 * @param {string} options.targetLang
 * @param {string} [options.creationTool]
 * @param {string} [options.creationToolVersion]
 * @param {string} [options.segtype='sentence']
 * @param {string} [options.oTmf='UTF-8']
 * @param {string} [options.adminLang='en']
 * @param {string} [options.dataType='plaintext']
 * @param {boolean} [options.includeProvenance=true]  add <prop type="x-source-url"/"x-target-url">
 * @param {Date} [options.now]
 * @returns {Promise<{ path: string, bytes: number, units: number, skipped: number }>}
 */
export async function writeTmx(filePath, units, {
  sourceLang,
  targetLang,
  creationTool = 'site-tmx-aligner',
  creationToolVersion = '1.0.0',
  segtype = 'sentence',
  oTmf = 'UTF-8',
  adminLang = 'en',
  dataType = 'plaintext',
  includeProvenance = true,
  now = new Date(),
}) {
  if (!sourceLang || !targetLang) throw new Error('writeTmx requires sourceLang and targetLang');
  if (!TMX_SEGTYPES.includes(segtype)) throw new Error(`Invalid TMX segtype "${segtype}"`);

  await mkdir(dirname(filePath), { recursive: true });
  const partialPath = `${filePath}.partial`;
  const stream = createWriteStream(partialPath, { encoding: 'utf8' });
  let failure = null;
  stream.on('error', (error) => {
    failure ??= error;
  });

  const xml = createCB({
    data: (chunk) => {
      stream.write(chunk);
    },
    prettyPrint: true,
    wellFormed: true,
  });
  xml.on('error', (error) => {
    failure ??= error;
  });

  let written = 0;
  let skipped = 0;
  try {
    xml.dec({ version: '1.0', encoding: 'UTF-8' });
    xml.ele('tmx', { version: '1.4' });
    xml.ele('header', {
      creationtool: xmlText(creationTool),
      creationtoolversion: xmlText(creationToolVersion),
      segtype,
      'o-tmf': xmlText(oTmf),
      adminlang: xmlText(adminLang),
      srclang: xmlText(sourceLang),
      datatype: xmlText(dataType),
      creationdate: tmxDate(now),
    }).up();
    xml.ele('body');

    for (const unit of units) {
      const source = sanitizeXmlText(unit.source).trim();
      const target = sanitizeXmlText(unit.target).trim();
      if (!source || !target) {
        skipped += 1;
        continue;
      }
      written += 1;
      xml.ele('tu', { tuid: String(written) });
      if (includeProvenance && unit.sourceUrl) {
        xml.ele('prop', { type: 'x-source-url' }).txt(xmlText(unit.sourceUrl)).up();
      }
      if (includeProvenance && unit.targetUrl) {
        xml.ele('prop', { type: 'x-target-url' }).txt(xmlText(unit.targetUrl)).up();
      }
      if (includeProvenance && unit.origin) {
        xml.ele('prop', { type: 'x-origin' }).txt(xmlText(unit.origin)).up();
      }
      xml.ele('tuv').att(XML_NS, 'xml:lang', xmlText(sourceLang)).ele('seg').txt(escapeXml(source)).up().up();
      xml.ele('tuv').att(XML_NS, 'xml:lang', xmlText(targetLang)).ele('seg').txt(escapeXml(target)).up().up();
      xml.up();

      if (failure) throw failure;
      if (stream.writableNeedDrain) await once(stream, 'drain');
    }

    xml.up(); // </body>
    xml.up(); // </tmx>
    xml.end();
    if (failure) throw failure;

    stream.end();
    await once(stream, 'finish');
    if (failure) throw failure;
  } catch (error) {
    stream.destroy();
    await rm(partialPath, { force: true });
    throw new Error(`Failed to write TMX: ${error.message}`, { cause: error });
  }

  await rename(partialPath, filePath);
  const { size } = await stat(filePath);
  return { path: filePath, bytes: size, units: written, skipped };
}

/**
 * Re-reads a TMX file and checks well-formedness and TMX 1.4 structure.
 *
 * @param {string} filePath
 * @param {object} options
 * @param {string} options.sourceLang
 * @param {string} options.targetLang
 * @param {number} [options.expectedUnits]
 * @param {number} [options.maxBytes=DEEPL_MAX_TMX_BYTES]
 * @param {number} [options.maxParseBytes=512 MiB]  above this only the size check runs
 * @returns {Promise<{ ok: boolean, problems: string[], bytes: number, units: number | null, parsed: boolean }>}
 */
export async function verifyTmx(filePath, {
  sourceLang,
  targetLang,
  expectedUnits,
  maxBytes = DEEPL_MAX_TMX_BYTES,
  maxParseBytes = 512 * 1024 * 1024,
}) {
  const problems = [];
  const { size } = await stat(filePath);
  if (size > maxBytes) {
    problems.push(`File is ${size} bytes, above the ${maxBytes}-byte upload limit`);
  }
  if (size > maxParseBytes) {
    return { ok: problems.length === 0, problems, bytes: size, units: null, parsed: false };
  }

  const xml = await readFile(filePath, 'utf8');
  const wellFormed = XMLValidator.validate(xml);
  if (wellFormed !== true) {
    problems.push(`Not well-formed XML: ${wellFormed.err.msg} (line ${wellFormed.err.line})`);
    return { ok: false, problems, bytes: size, units: null, parsed: false };
  }

  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: '@_',
    parseTagValue: false,
    parseAttributeValue: false,
    trimValues: false,
    processEntities: true,
    isArray: (name) => name === 'tu' || name === 'tuv' || name === 'prop',
  });
  const doc = parser.parse(xml);
  const tmx = doc.tmx;
  if (!tmx) {
    problems.push('Missing <tmx> root element');
    return { ok: false, problems, bytes: size, units: null, parsed: true };
  }
  if (tmx['@_version'] !== '1.4') problems.push(`<tmx version> is "${tmx['@_version']}", expected "1.4"`);

  const header = tmx.header;
  if (!header || typeof header !== 'object') {
    problems.push('Missing <header>');
  } else {
    for (const attr of REQUIRED_HEADER_ATTRIBUTES) {
      if (!header[`@_${attr}`]) problems.push(`<header> is missing required attribute "${attr}"`);
    }
    if (header['@_srclang'] && header['@_srclang'] !== sourceLang) {
      problems.push(`<header srclang> is "${header['@_srclang']}", expected "${sourceLang}"`);
    }
    if (header['@_segtype'] && !TMX_SEGTYPES.includes(header['@_segtype'])) {
      problems.push(`<header segtype> "${header['@_segtype']}" is not a TMX 1.4 segtype`);
    }
  }

  if (!('body' in tmx)) problems.push('Missing <body>');
  const tus = Array.isArray(tmx.body?.tu) ? tmx.body.tu : [];
  const wanted = [sourceLang.toLowerCase(), targetLang.toLowerCase()];
  let badUnits = 0;
  tus.forEach((tu, i) => {
    const tuvs = Array.isArray(tu.tuv) ? tu.tuv : [];
    const langs = tuvs.map((tuv) => String(tuv['@_xml:lang'] ?? '').toLowerCase());
    const segsOk = tuvs.every((tuv) => typeof tuv.seg === 'string' && tuv.seg.trim().length > 0);
    if (!wanted.every((lang) => langs.includes(lang)) || !segsOk) {
      badUnits += 1;
      if (badUnits <= 20) problems.push(`<tu> #${i + 1} lacks a non-empty <seg> for ${wanted.join(' and ')}`);
    }
  });
  if (badUnits > 20) problems.push(`…and ${badUnits - 20} more invalid <tu> elements`);
  if (Number.isInteger(expectedUnits) && tus.length !== expectedUnits) {
    problems.push(`Found ${tus.length} <tu> elements, expected ${expectedUnits}`);
  }

  return { ok: problems.length === 0, problems, bytes: size, units: tus.length, parsed: true };
}
