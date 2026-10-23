/**
 * Segment alignment between a source page and its target-language counterpart.
 *
 * Pairing is purely positional ("same DOM layout index"); content heuristics are only used as
 * quality gates to *reject* suspicious pairs, never to invent new ones.
 *
 * Modes (paths are relative to the block's scope: its CMS anchor block, or the content root)
 *   strict    (default) same scope + identical tag path incl. sibling counts at every level
 *   path      same scope + identical tag path (index only) – more recall, less safe
 *   sequence  n-th block ↔ n-th block; only used when both pages have the same block count
 *
 * Quality gates (in this order): word range, untranslated, wrong language, length ratio,
 * numbers, protected tokens.
 */

import {
  countWords,
  isUntranslated,
  missingProtectedTokens,
  numberFingerprint,
  numbersMatch,
  readsAsSourceLanguage,
} from './text.js';

export const ALIGNMENT_MODES = Object.freeze(['strict', 'path', 'sequence']);

/**
 * @param {import('./extract.js').Block[]} sourceBlocks
 * @param {import('./extract.js').Block[]} targetBlocks
 * @param {object} options
 * @param {'strict'|'path'|'sequence'} [options.mode='strict']
 * @param {number} [options.minWords=4]
 * @param {number} [options.maxWords=80]
 * @param {number} [options.minLengthRatio=0.5]   target chars / source chars
 * @param {number} [options.maxLengthRatio=2.5]
 * @param {boolean} [options.requireNumberMatch=true]
 * @param {boolean} [options.requireProtectedTokens=true]  brand/model tokens must carry over
 * @param {boolean} [options.checkTargetLanguage=true]     reject targets that read as the source language
 * @param {string} [options.sourceLang]
 * @param {string} [options.targetLang]
 */
export function alignBlocks(sourceBlocks, targetBlocks, {
  mode = 'strict',
  minWords = 4,
  maxWords = 80,
  minLengthRatio = 0.5,
  maxLengthRatio = 2.5,
  requireNumberMatch = true,
  requireProtectedTokens = true,
  checkTargetLanguage = true,
  sourceLang,
  targetLang,
} = {}) {
  if (!ALIGNMENT_MODES.includes(mode)) {
    throw new Error(`Unknown alignment mode "${mode}". Use one of: ${ALIGNMENT_MODES.join(', ')}`);
  }

  const rejected = {};
  /** Every rejected source block with the reason, so a reviewer can see what was left out and why. */
  const rejectedPairs = [];
  const reject = (reason, src, tgt, detail = null) => {
    rejected[reason] = (rejected[reason] ?? 0) + 1;
    if (src) rejectedPairs.push({ reason, source: src.text, target: tgt?.text ?? null, detail, scope: src.scope ?? null });
  };

  /** @type {[import('./extract.js').Block, import('./extract.js').Block][]} */
  const candidates = [];

  if (mode === 'sequence') {
    if (sourceBlocks.length !== targetBlocks.length) {
      rejected['block-count-mismatch'] = sourceBlocks.length;
    } else {
      sourceBlocks.forEach((src, i) => {
        const tgt = targetBlocks[i];
        if (src.tag === tgt.tag) candidates.push([src, tgt]);
        else reject('tag-mismatch', src, tgt, `${src.tag} vs ${tgt.tag}`);
      });
    }
  } else {
    const field = mode === 'strict' ? 'strictPath' : 'path';
    const keyOf = (block) => `${block.scope ?? '@0'}|${block[field]}`;
    const targetsByKey = new Map(targetBlocks.map((b) => [keyOf(b), b]));
    for (const src of sourceBlocks) {
      const tgt = targetsByKey.get(keyOf(src));
      if (tgt) candidates.push([src, tgt]);
      else reject('no-structural-match', src, null, keyOf(src));
    }
  }

  const pairs = [];
  for (const [src, tgt] of candidates) {
    const words = countWords(src.text);
    if (words < minWords || words > maxWords) {
      reject('word-range', src, tgt, `${words} words`);
      continue;
    }
    if (isUntranslated(src.text, tgt.text)) {
      reject('untranslated', src, tgt);
      continue;
    }
    if (checkTargetLanguage && readsAsSourceLanguage(tgt.text, sourceLang, targetLang)) {
      reject('wrong-language', src, tgt, `target reads as "${sourceLang}"`);
      continue;
    }
    const ratio = tgt.text.length / src.text.length;
    if (ratio < minLengthRatio || ratio > maxLengthRatio) {
      reject('length-ratio', src, tgt, `ratio ${ratio.toFixed(2)}`);
      continue;
    }
    if (requireNumberMatch && !numbersMatch(src.text, tgt.text)) {
      reject('number-mismatch', src, tgt,
        `numbers [${numberFingerprint(src.text).join(', ')}] vs [${numberFingerprint(tgt.text).join(', ')}]`);
      continue;
    }
    const missing = requireProtectedTokens ? missingProtectedTokens(src.text, tgt.text) : [];
    if (missing.length) {
      reject('protected-token-mismatch', src, tgt, `missing in target: ${missing.join(', ')}`);
      continue;
    }
    pairs.push({ source: src.text, target: tgt.text, scope: src.scope, path: src.path, index: src.index });
  }

  return {
    pairs,
    rejectedPairs,
    stats: {
      sourceBlocks: sourceBlocks.length,
      targetBlocks: targetBlocks.length,
      structuralMatches: candidates.length,
      accepted: pairs.length,
      rejected,
    },
  };
}

/**
 * Global de-duplication across pages. The first occurrence of a source string wins; a later
 * occurrence with a *different* translation is counted as a conflict so it can be reviewed.
 * @param {{ source: string, target: string }[]} units  in deterministic order
 */
export function dedupeUnits(units) {
  const bySource = new Map();
  let duplicates = 0;
  let conflicts = 0;
  const conflictSamples = [];
  for (const unit of units) {
    const existing = bySource.get(unit.source);
    if (!existing) {
      bySource.set(unit.source, unit);
    } else if (existing.target === unit.target) {
      duplicates += 1;
    } else {
      conflicts += 1;
      if (conflictSamples.length < 100) {
        conflictSamples.push({
          source: unit.source,
          kept: existing.target,
          keptFrom: existing.sourceUrl,
          dropped: unit.target,
          droppedFrom: unit.sourceUrl,
        });
      }
    }
  }
  return { units: [...bySource.values()], duplicates, conflicts, conflictSamples };
}
