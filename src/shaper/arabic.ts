// Arabic contextual shaper.
//
// The problem: a grapheme-aware VT puts one Arabic letter in each cell (the
// torture corpus records this as the `split` layout, measured against
// ghostty-vt). Drawing each cell's letter on its own gives the isolated form, so
// a word never joins. Correct Arabic needs each letter's contextual form, which
// depends on its logical neighbours, and it needs the letters laid out
// right-to-left so the joining strokes meet.
//
// This shaper does NOT implement Unicode joining or ship a shaping engine. It
// derives each letter's joining context from the Unicode joining types below and
// then hands the browser a cluster that forces that context: a ZWJ on the side
// that joins. Chromium's canvas resolves that through its own text engine and
// returns the right contextual glyph, so the shaping is HarfBuzz's, not ours.
//
// The one non-obvious part is direction. A trailing ZWJ is only honoured when
// the raster context is RTL; under the default LTR direction it is dropped and
// every letter comes back isolated or final. That is why ShapedGlyph carries
// `rtl`, and it is measured rather than assumed (docs/limits.md records the
// experiment).
//
// Scope is deliberately narrow and is spelled out in docs/limits.md: joining
// forms and run-local right-to-left ordering for the Arabic block, on one line,
// within one run of uniform style. It is not the Unicode Bidirectional
// Algorithm. Word order across a space is not reversed, neutrals are not
// resolved, brackets are not mirrored, and no other joining script is handled.

import type { RunStyle, ShapedGlyph, ShapedRun, ShaperHook } from '../types.ts';

/** Zero-width joiner. Forces a joining context on the side it sits. */
const ZWJ = '\u200d';

/**
 * Unicode joining types, from ArabicShaping.txt. Only the classes that change
 * the algorithm are distinguished:
 *
 *   D  dual-joining:  joins on both sides (most letters)
 *   R  right-joining: joins only to the preceding letter (alef, dal, reh, waw)
 *   T  transparent:   combining marks; invisible to the joining algorithm
 *   U  non-joining:   joins on neither side (hamza, digits, punctuation)
 *   C  join-causing:  joins on both sides but has no forms of its own (tatweel)
 */
const Joining = {
  U: 0,
  D: 1,
  R: 2,
  T: 3,
  C: 4,
} as const;
type Joining = (typeof Joining)[keyof typeof Joining];

/**
 * Joining type by code point for the Arabic block, U+0600..U+06FF, as sorted
 * [start, end, type] ranges. Anything outside the listed ranges is U, which is
 * the safe answer: a letter the table does not know simply does not join.
 *
 * Deliberately limited to the main Arabic block. Arabic Supplement (U+0750),
 * Extended-A (U+08A0) and the other joining scripts (Syriac, N'Ko, Mongolian,
 * Adlam) use the same mechanism and would fall out of the same code, but their
 * tables are not transcribed here and nothing in the test corpus exercises them,
 * so claiming them would be claiming untested work.
 */
const RANGES: readonly (readonly [number, number, Joining])[] = [
  [0x0610, 0x061a, Joining.T], // honorifics and Quranic marks
  [0x061c, 0x061c, Joining.T], // ARABIC LETTER MARK
  [0x0620, 0x0620, Joining.D],
  [0x0621, 0x0621, Joining.U], // HAMZA
  [0x0622, 0x0625, Joining.R], // alef with madda/hamza, waw with hamza
  [0x0626, 0x0626, Joining.D],
  [0x0627, 0x0627, Joining.R], // ALEF
  [0x0628, 0x0628, Joining.D], // BEH
  [0x0629, 0x0629, Joining.R], // TEH MARBUTA
  [0x062a, 0x062e, Joining.D], // teh .. khah
  [0x062f, 0x0632, Joining.R], // dal, thal, reh, zain
  [0x0633, 0x063f, Joining.D], // seen .. keheh variants
  [0x0640, 0x0640, Joining.C], // TATWEEL
  [0x0641, 0x0647, Joining.D], // feh .. heh
  [0x0648, 0x0648, Joining.R], // WAW
  [0x0649, 0x064a, Joining.D], // alef maksura, yeh
  [0x064b, 0x065f, Joining.T], // harakat and other combining marks
  [0x0660, 0x066d, Joining.U], // Arabic-Indic digits and punctuation
  [0x066e, 0x066f, Joining.D], // dotless beh, dotless qaf
  [0x0670, 0x0670, Joining.T], // SUPERSCRIPT ALEF
  [0x0671, 0x0673, Joining.R],
  [0x0674, 0x0674, Joining.U], // HIGH HAMZA
  [0x0675, 0x0677, Joining.R],
  [0x0678, 0x0687, Joining.D],
  [0x0688, 0x0699, Joining.R],
  [0x069a, 0x06bf, Joining.D],
  [0x06c0, 0x06c0, Joining.R],
  [0x06c1, 0x06c2, Joining.D],
  [0x06c3, 0x06cb, Joining.R],
  [0x06cc, 0x06cc, Joining.D],
  [0x06cd, 0x06cd, Joining.R],
  [0x06ce, 0x06ce, Joining.D],
  [0x06cf, 0x06cf, Joining.R],
  [0x06d0, 0x06d1, Joining.D],
  [0x06d2, 0x06d3, Joining.R],
  [0x06d5, 0x06d5, Joining.R],
  [0x06d6, 0x06dc, Joining.T],
  [0x06df, 0x06e4, Joining.T],
  [0x06e7, 0x06e8, Joining.T],
  [0x06ea, 0x06ed, Joining.T],
  [0x06ee, 0x06ef, Joining.R],
  [0x06fa, 0x06fc, Joining.D],
  [0x06ff, 0x06ff, Joining.D],
];

const BLOCK_START = 0x0600;
const BLOCK_END = 0x06ff;

/** Joining type of a code point. Binary search over the range table. */
export function joiningType(cp: number): number {
  let lo = 0;
  let hi = RANGES.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const r = RANGES[mid];
    if (cp < r[0]) hi = mid - 1;
    else if (cp > r[1]) lo = mid + 1;
    else return r[2];
  }
  return Joining.U;
}

/** True for any code point in the Arabic block, shaped or not. */
export function isArabic(cp: number): boolean {
  return cp >= BLOCK_START && cp <= BLOCK_END;
}

/** Arabic-Indic and extended Arabic-Indic digits, which keep their own order. */
function isArabicDigit(cp: number): boolean {
  return (cp >= 0x0660 && cp <= 0x0669) || (cp >= 0x06f0 && cp <= 0x06f9);
}

/**
 * Contextual shaper for the Arabic block.
 *
 * Two things happen to a run, and both are needed for either to be worth doing:
 *
 *   1. Joining. Each letter is rastered with a ZWJ on whichever side joins, so
 *      the browser picks the initial/medial/final/isolated form.
 *   2. Run-local reordering. The cells of the run are reversed, because a joined
 *      letter's connecting stroke points at its neighbour and Arabic neighbours
 *      run right to left. Shaping without reversing produces letters whose
 *      strokes point away from each other, which is worse than the isolated
 *      forms it replaces, so this shaper does not offer that as an option.
 *
 * Reordering is why this is opt-in. It breaks the identity between a cell's
 * index and the column its character is drawn in, so `cellAtPixel` inside a
 * shaped run names a cell whose character is somewhere else in the run.
 */
export function arabicShaper(): ShaperHook {
  return {
    participates: isArabic,
    shapeRun(cells: readonly string[], style: RunStyle): ShapedRun {
      const n = cells.length;
      // Joining is decided on the base letter of each cell. A cell's grapheme
      // may carry combining marks; those are transparent to joining, and taking
      // the first scalar drops them from the decision without dropping them from
      // the raster.
      const base = new Array<number>(n);
      for (let i = 0; i < n; i++) base[i] = cells[i].codePointAt(0) ?? 0;

      const glyphs: ShapedGlyph[] = [];
      const styleTag = (style.bold ? 'b' : '') + (style.italic ? 'i' : '');

      for (let i = 0; i < n; i++) {
        const jt = joiningType(base[i]);
        // A transparent cell (a lone combining mark in its own cell) is not a
        // letter and gets no context of its own.
        // Each side asks two questions: can this letter take a joined form on
        // that side, and does the neighbour offer a connection on the facing
        // side. The two are not the same predicate. Alef only joins backward,
        // so it cannot start a connection to the letter after it but it does
        // accept one from the letter before it, which is what makes the lam in
        // salaam medial rather than final.
        const joinPrev =
          jt !== Joining.T && joinsBackward(jt) && joinsForward(prevBase(base, i));
        const joinNext =
          jt !== Joining.T && joinsForward(jt) && joinsBackward(nextBase(base, i));
        const cluster = (joinPrev ? ZWJ : '') + cells[i] + (joinNext ? ZWJ : '');
        // Only a letter that actually joins needs either treatment. Fitting
        // exists so connecting strokes meet on the cell boundary, so a letter
        // with nothing to connect to (a hamza, a digit, a lone alef) keeps its
        // natural advance instead of being stretched to fill the cell for no
        // reason. That also leaves a one-letter run rendering exactly as it does
        // with no shaper configured at all.
        const joined = joinPrev || joinNext;
        glyphs.push({
          // Namespaced away from the default path's `grapheme + mask` keys on
          // purpose: a fitted raster of a letter is not interchangeable with the
          // plain one, and sharing a key would poison the unshaped entry.
          atlasKey: 'ar\u0001' + styleTag + (joined ? 'j' : '') + '\u0001' + cluster,
          cluster,
          col: reorder(base, i),
          xOffset: 0,
          rtl: joined,
          fitAdvance: joined,
        });
      }
      return { glyphs };
    },
  };
}

/** Joining type of the nearest preceding non-transparent cell, or U. */
function prevBase(base: number[], i: number): number {
  for (let k = i - 1; k >= 0; k--) {
    if (joiningType(base[k]) !== Joining.T) return joiningType(base[k]);
  }
  return Joining.U;
}

/** Joining type of the nearest following non-transparent cell, or U. */
function nextBase(base: number[], i: number): number {
  for (let k = i + 1; k < base.length; k++) {
    if (joiningType(base[k]) !== Joining.T) return joiningType(base[k]);
  }
  return Joining.U;
}

/**
 * This letter connects on the side facing the letter before it: it can take a
 * joined form there, and equally it offers a connection to that neighbour.
 */
function joinsBackward(jt: number): boolean {
  return jt === Joining.D || jt === Joining.R || jt === Joining.C;
}

/** As above, on the side facing the letter after it. Right-joiners cannot. */
function joinsForward(jt: number): boolean {
  return jt === Joining.D || jt === Joining.C;
}

/**
 * Column for the cell at logical index `i` once the run is laid out visually.
 *
 * The run reverses, because it is right-to-left. Digits are the exception the
 * Unicode algorithm also makes: a number inside a right-to-left run keeps its
 * own digits in reading order, so a contiguous span of Arabic-Indic digits is
 * reversed as a block and not internally. Without this a three-digit number
 * inside an Arabic word would come out backwards, which is exactly the kind of
 * quietly-wrong output the visible improvement would hide.
 */
function reorder(base: number[], i: number): number {
  const n = base.length;
  if (!isArabicDigit(base[i])) return n - 1 - i;
  let start = i;
  while (start > 0 && isArabicDigit(base[start - 1])) start--;
  let end = i;
  while (end + 1 < n && isArabicDigit(base[end + 1])) end++;
  // The span occupies columns [n-1-end, n-1-start] after reversal; place this
  // digit at its unreversed offset inside that span.
  return n - 1 - end + (i - start);
}
