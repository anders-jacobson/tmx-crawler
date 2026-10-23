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
 * Structure guard (strict/path modes): when a scope's sequence of block tags differs between the
 * two pages, the translated page has reordered, added or dropped blocks, and equal per-tag counts
 * can still occur by coincidence so that positional pairing slides by one ("structure-drift").
 *   prefix  (default) keep the blocks before the first point where the sequences diverge, minus
 *           the run of same-tag blocks right before it (an insertion there is invisible); drop the rest
 *   scope   drop every pair of the scope – safest, but loses all text before the divergence too
 *   off     no guard
 *
 * Quality gates (in this order): suppression list, word range, untranslated, unexpected
 * characters, wrong language, length ratio, numbers, protected tokens.
 */

import {
  compileTokenEquivalents,
  countWords,
  isUntranslated,
  looksGarbled,
  missingProtectedTokens,
  normalizeText,
  numberFingerprint,
  numbersMatch,
  readsAsSourceLanguage,
} from './text.js';

export const ALIGNMENT_MODES = Object.freeze(['strict', 'path', 'sequence']);
export const STRUCTURE_GUARDS = Object.freeze(['prefix', 'scope', 'off']);

const scopeKey = (block) => block.scope ?? '@0';

/**
 * Tag sequence of every scope in document order, and each block's position within its scope.
 * @returns {{ sequences: Map<string, string[]>, positions: Map<object, number> }}
 */
function scopeLayout(blocks) {
  const sequences = new Map();
  const positions = new Map();
  for (const block of blocks) {
    const key = scopeKey(block);
    if (!sequences.has(key)) sequences.set(key, []);
    const sequence = sequences.get(key);
    positions.set(block, sequence.length);
    sequence.push(block.tag);
  }
  return { sequences, positions };
}

/**
 * Compares two tag sequences. `safe` is the number of leading blocks that can still be paired:
 * everything before the first difference, minus the run of blocks right before it that share a
 * tag with either side of the difference – a paragraph inserted inside such a run shows up only
 * where the run ends, but already shifts the run itself.
 * @returns {{ same: boolean, diverge: number, safe: number }}
 */
export function compareLayouts(a = [], b = []) {
  let diverge = 0;
  while (diverge < a.length && diverge < b.length && a[diverge] === b[diverge]) diverge += 1;
  if (diverge === a.length && diverge === b.length) return { same: true, diverge, safe: diverge };
  let safe = diverge;
  while (safe > 0 && (a[safe - 1] === a[diverge] || a[safe - 1] === b[diverge])) safe -= 1;
  return { same: false, diverge, safe };
}

function describeDrift(a = [], b = [], { diverge, safe }) {
  return `block sequence differs at position ${diverge + 1} (${a[diverge] ?? 'end'} vs ${b[diverge] ?? 'end'}; `
    + `${a.length} vs ${b.length} blocks); ${safe} leading block(s) kept`;
}

/**
 * Lookup for pairs that must never be emitted, e.g. known mis-pairings confirmed by a reviewer.
 * @param {{ source: string, target?: string }[]} [entries]  without `target`, the source is suppressed with any target
 */
export function compileSuppressions(entries) {
  const bySource = new Map();
  for (const entry of entries ?? []) {
    const source = normalizeText(entry?.source);
    if (!source) continue;
    if (!bySource.has(source)) bySource.set(source, new Set());
    bySource.get(source).add(entry.target === undefined || entry.target === null ? '*' : normalizeText(entry.target));
  }
  return (source, target) => {
    const targets = bySource.get(source);
    return Boolean(targets && (targets.has('*') || targets.has(target)));
  };
}

/**
 * The content quality gates for one source/target pair, shared by the aligner and the review
 * suggestions. Returns null when the pair passes, else { reason, detail }.
 * @param {object} options  same gate options as alignBlocks
 */
export function makePairChecker({
  minWords = 4,
  maxWords = 80,
  minLengthRatio = 0.5,
  maxLengthRatio = 2.5,
  minWordsByTag = {},
  lengthRatioMinWords = 4,
  requireNumberMatch = true,
  requireProtectedTokens = true,
  checkTargetLanguage = true,
  checkCharacters = true,
  tokenEquivalents = null,
  suppressPairs = null,
  sourceLang,
  targetLang,
} = {}) {
  const equivalents = compileTokenEquivalents(tokenEquivalents, targetLang);
  const isSuppressed = compileSuppressions(suppressPairs);
  const fail = (reason, detail = null) => ({ reason, detail });
  return (src, tgt) => {
    if (isSuppressed(src.text, tgt.text)) return fail('suppressed', 'listed in alignment.suppressPairs');
    const words = countWords(src.text);
    const min = minWordsByTag?.[src.tag] ?? minWords;
    if (words < min || words > maxWords) return fail('word-range', `${words} words`);
    if (isUntranslated(src.text, tgt.text)) return fail('untranslated');
    if (checkCharacters) {
      const garbled = looksGarbled(tgt.text, targetLang) ? targetLang : looksGarbled(src.text, sourceLang) ? sourceLang : null;
      if (garbled) return fail('unexpected-characters', `mostly letters outside the "${garbled}" alphabet (placeholder or pseudo-localised text?)`);
    }
    if (checkTargetLanguage && readsAsSourceLanguage(tgt.text, sourceLang, targetLang, src.text)) {
      return fail('wrong-language', `target reads as "${sourceLang}"`);
    }
    const ratio = tgt.text.length / src.text.length;
    if (words >= lengthRatioMinWords && (ratio < minLengthRatio || ratio > maxLengthRatio)) {
      return fail('length-ratio', `ratio ${ratio.toFixed(2)}`);
    }
    if (requireNumberMatch && !numbersMatch(src.text, tgt.text, sourceLang, targetLang)) {
      return fail('number-mismatch', `numbers [${numberFingerprint(src.text).join(', ')}] vs [${numberFingerprint(tgt.text).join(', ')}]`);
    }
    const missing = requireProtectedTokens ? missingProtectedTokens(src.text, tgt.text, equivalents) : [];
    if (missing.length) return fail('protected-token-mismatch', `missing in target: ${missing.join(', ')}`);
    return null;
  };
}

/**
 * @param {import('./extract.js').Block[]} sourceBlocks
 * @param {import('./extract.js').Block[]} targetBlocks
 * @param {object} options
 * @param {'strict'|'path'|'sequence'} [options.mode='strict']
 * @param {number} [options.minWords=4]
 * @param {number} [options.maxWords=80]
 * @param {number} [options.minLengthRatio=0.5]   target chars / source chars
 * @param {number} [options.maxLengthRatio=2.5]
 * @param {Record<string, number>} [options.minWordsByTag]  per-tag minimum, e.g. { h2: 1 } keeps short headings
 * @param {number} [options.lengthRatioMinWords=4]  apply the length-ratio check only from this many source
 *                                                  words up – character ratios are meaningless for "FAQ"
 * @param {boolean} [options.requireNumberMatch=true]
 * @param {boolean} [options.requireProtectedTokens=true]  brand/model tokens must carry over
 * @param {boolean} [options.checkTargetLanguage=true]     reject targets that read as the source language
 * @param {'prefix'|'scope'|'off'} [options.structureGuard='prefix']  see above
 * @param {boolean} [options.checkCharacters=true]       reject text dominated by letters foreign to its
 *                                                       language (pseudo-localised placeholder text)
 * @param {Record<string, Record<string, string[]>>} [options.tokenEquivalents]
 *        per target language, accepted target forms of protected tokens, e.g. { de: { CSSD: ['AEMP'] } }
 * @param {{ source: string, target?: string }[]} [options.suppressPairs]  pairs never to emit
 * @param {string} [options.sourceLang]
 * @param {string} [options.targetLang]
 */
export function alignBlocks(sourceBlocks, targetBlocks, options = {}) {
  const { mode = 'strict', structureGuard = 'prefix' } = options;
  if (!ALIGNMENT_MODES.includes(mode)) {
    throw new Error(`Unknown alignment mode "${mode}". Use one of: ${ALIGNMENT_MODES.join(', ')}`);
  }
  if (!STRUCTURE_GUARDS.includes(structureGuard)) {
    throw new Error(`Unknown structure guard "${structureGuard}". Use one of: ${STRUCTURE_GUARDS.join(', ')}`);
  }
  const checkPair = makePairChecker(options);

  const rejected = {};
  /** Every rejected source block with the reason, so a reviewer can see what was left out and why. */
  const rejectedPairs = [];
  const reject = (reason, src, tgt, detail = null) => {
    rejected[reason] = (rejected[reason] ?? 0) + 1;
    if (src) rejectedPairs.push({ reason, tag: src.tag, source: src.text, target: tgt?.text ?? null, detail, scope: src.scope ?? null });
  };

  /** @type {[import('./extract.js').Block, import('./extract.js').Block][]} */
  const candidates = [];
  /**
   * Parts of scopes after a layout difference: every source and target block from the first
   * unsafe position on. Nothing here is paired automatically; the review sheet suggests pairings.
   */
  const driftRegions = [];

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
    const guarded = structureGuard !== 'off';
    const source = guarded ? scopeLayout(sourceBlocks) : null;
    const target = guarded ? scopeLayout(targetBlocks) : null;
    const comparisons = new Map();
    for (const src of sourceBlocks) {
      const tgt = targetsByKey.get(keyOf(src));
      if (!tgt) {
        reject('no-structural-match', src, null, keyOf(src));
        continue;
      }
      if (guarded) {
        const scope = scopeKey(src);
        const a = source.sequences.get(scope);
        const b = target.sequences.get(scope) ?? [];
        if (!comparisons.has(scope)) comparisons.set(scope, compareLayouts(a, b));
        const comparison = comparisons.get(scope);
        const keep = structureGuard === 'prefix' ? comparison.safe : 0;
        if (!comparison.same && (source.positions.get(src) >= keep || target.positions.get(tgt) >= keep)) {
          reject('structure-drift', src, tgt, describeDrift(a, b, structureGuard === 'prefix' ? comparison : { ...comparison, safe: 0 }));
          continue;
        }
      }
      candidates.push([src, tgt]);
    }
    if (guarded) {
      const sourceByScope = Map.groupBy(sourceBlocks, scopeKey);
      const targetByScope = Map.groupBy(targetBlocks, scopeKey);
      for (const [scope, blocks] of sourceByScope) {
        const others = targetByScope.get(scope);
        if (!others) continue;
        const comparison = comparisons.get(scope)
          ?? compareLayouts(source.sequences.get(scope), target.sequences.get(scope));
        if (comparison.same) continue;
        const keep = structureGuard === 'prefix' ? comparison.safe : 0;
        driftRegions.push({
          scope,
          source: blocks.filter((b) => source.positions.get(b) >= keep),
          target: others.filter((b) => target.positions.get(b) >= keep),
        });
      }
    }
  }

  const pairs = [];
  for (const [src, tgt] of candidates) {
    const failure = checkPair(src, tgt);
    if (failure) {
      reject(failure.reason, src, tgt, failure.detail);
      continue;
    }
    pairs.push({ source: src.text, target: tgt.text, scope: src.scope, path: src.path, index: src.index });
  }

  return {
    pairs,
    rejectedPairs,
    driftRegions,
    stats: {
      sourceBlocks: sourceBlocks.length,
      targetBlocks: targetBlocks.length,
      structuralMatches: candidates.length,
      accepted: pairs.length,
      rejected,
    },
  };
}

function trigrams(value) {
  const text = ` ${String(value).toLowerCase().replace(/\s+/gu, ' ')} `;
  const grams = new Set();
  for (let i = 0; i < text.length - 2; i += 1) grams.add(text.slice(i, i + 3));
  return grams;
}

/** Character-trigram Dice similarity, 0…1. */
export function textSimilarity(a, b) {
  const ga = trigrams(a);
  const gb = trigrams(b);
  let shared = 0;
  for (const gram of ga) if (gb.has(gram)) shared += 1;
  return ga.size + gb.size ? (2 * shared) / (ga.size + gb.size) : 1;
}

/**
 * Global de-duplication across pages. When one source string has several translations:
 *   - the translation used most often wins ("majority");
 *   - on a tie, the first-seen one wins if the tied variants are near-identical wording
 *     ("similar-variants"), e.g. small edits in repeated legal text;
 *   - otherwise the source is left out entirely ("divergent-dropped"): the translations say
 *     different things, so one of them is page-specific or a mis-pairing.
 * A pair approved in the review sheet (`reviewed: true`) always wins ("reviewed").
 * Every occurrence is accounted for: kept + duplicates + conflicts = input length.
 * @param {{ source: string, target: string, sourceUrl?: string }[]} units  in deterministic order
 * @param {{ minVariantSimilarity?: number, maxSamples?: number }} [options]
 */
export function dedupeUnits(units, { minVariantSimilarity = 0.4, maxSamples = 200 } = {}) {
  const groups = new Map();
  for (const unit of units) {
    let group = groups.get(unit.source);
    if (!group) groups.set(unit.source, (group = new Map()));
    const variant = group.get(unit.target);
    if (variant) {
      variant.count += 1;
      if (unit.reviewed && !variant.unit.reviewed) variant.unit = unit;
    } else group.set(unit.target, { unit, count: 1 });
  }

  const kept = [];
  let duplicates = 0;
  let conflicts = 0;
  let divergentDropped = 0;
  const samples = [];
  for (const [source, group] of groups) {
    const variants = [...group.values()];
    const total = variants.reduce((sum, v) => sum + v.count, 0);
    if (variants.length === 1) {
      kept.push(variants[0].unit);
      duplicates += total - 1;
      continue;
    }
    const top = Math.max(...variants.map((v) => v.count));
    const leaders = variants.filter((v) => v.count === top);
    const reviewed = variants.find((v) => v.unit.reviewed);
    let chosen = null;
    let resolution = 'divergent-dropped';
    if (reviewed) {
      chosen = reviewed;
      resolution = 'reviewed';
    } else if (leaders.length === 1) {
      [chosen] = leaders;
      resolution = 'majority';
    } else if (leaders.every((a, i) => leaders.slice(i + 1).every((b) => textSimilarity(a.unit.target, b.unit.target) >= minVariantSimilarity))) {
      [chosen] = leaders;
      resolution = 'similar-variants';
    }
    if (chosen) {
      kept.push(chosen.unit);
      duplicates += chosen.count - 1;
      conflicts += total - chosen.count;
    } else {
      divergentDropped += 1;
      conflicts += total;
    }
    samples.push({
      source,
      resolution,
      kept: chosen?.unit.target ?? null,
      keptFrom: chosen?.unit.sourceUrl ?? null,
      variants: variants.map((v) => ({ target: v.unit.target, count: v.count, from: v.unit.sourceUrl })),
    });
  }
  // Dropped sources first – they are the ones a reviewer may want to look at.
  const rank = { 'divergent-dropped': 0, majority: 1, 'similar-variants': 2, reviewed: 3 };
  const conflictSamples = samples
    .map((sample, i) => ({ sample, i }))
    .sort((x, y) => rank[x.sample.resolution] - rank[y.sample.resolution] || x.i - y.i)
    .slice(0, maxSamples)
    .map(({ sample }) => sample);
  return { units: kept, duplicates, conflicts, divergentDropped, conflictSamples };
}
