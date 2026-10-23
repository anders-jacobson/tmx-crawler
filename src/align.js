/**
 * Segment alignment between a source page and its target-language counterpart.
 *
 * Pairing is purely positional ("same DOM layout index"); content heuristics are only used as
 * quality gates to *reject* suspicious pairs, never to invent new ones.
 *
 * Modes
 *   strict    (default) identical tag path incl. sibling counts at every level
 *   path      identical tag path (index only) – more recall, tolerates added siblings elsewhere
 *   sequence  n-th block ↔ n-th block; only used when both pages have the same block count
 */

import { countWords, isUntranslated, numbersMatch } from './text.js';

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
 */
export function alignBlocks(sourceBlocks, targetBlocks, {
  mode = 'strict',
  minWords = 4,
  maxWords = 80,
  minLengthRatio = 0.5,
  maxLengthRatio = 2.5,
  requireNumberMatch = true,
} = {}) {
  if (!ALIGNMENT_MODES.includes(mode)) {
    throw new Error(`Unknown alignment mode "${mode}". Use one of: ${ALIGNMENT_MODES.join(', ')}`);
  }

  const rejected = {};
  const reject = (reason) => {
    rejected[reason] = (rejected[reason] ?? 0) + 1;
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
        else reject('tag-mismatch');
      });
    }
  } else {
    const key = mode === 'strict' ? 'strictPath' : 'path';
    const targetsByKey = new Map(targetBlocks.map((b) => [b[key], b]));
    for (const src of sourceBlocks) {
      const tgt = targetsByKey.get(src[key]);
      if (tgt) candidates.push([src, tgt]);
      else reject('no-structural-match');
    }
  }

  const pairs = [];
  for (const [src, tgt] of candidates) {
    const words = countWords(src.text);
    if (words < minWords || words > maxWords) {
      reject('word-range');
      continue;
    }
    if (isUntranslated(src.text, tgt.text)) {
      reject('untranslated');
      continue;
    }
    const ratio = tgt.text.length / src.text.length;
    if (ratio < minLengthRatio || ratio > maxLengthRatio) {
      reject('length-ratio');
      continue;
    }
    if (requireNumberMatch && !numbersMatch(src.text, tgt.text)) {
      reject('number-mismatch');
      continue;
    }
    pairs.push({ source: src.text, target: tgt.text, path: src.path, index: src.index });
  }

  return {
    pairs,
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
