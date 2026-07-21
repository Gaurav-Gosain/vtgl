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
// then selects the letter's contextual glyph directly: Unicode encodes the four
// joining forms of every core Arabic letter as distinct code points in Arabic
// Presentation Forms-B (U+FE70..U+FEFF), so the shaper maps base letter plus
// join context to the isolated, initial, medial or final form and rasters that.
// The browser draws the form it is handed; no per-engine text behaviour is
// relied on, so the joining forms are identical on Chromium and Firefox.
//
// Two things this earns over the older approach. It measured whether the browser
// would resolve a zero-width joiner into a contextual form, and Chromium would
// but Firefox honoured only a trailing joiner and dropped a leading one, so a
// word came out with its medial and final letters unjoined on Firefox. Selecting
// the presentation form ourselves removes that dependency. It also gives the
// lam-alef ligature a code point of its own (U+FEF5..U+FEFC), so lam followed by
// alef is drawn as the single ligature glyph fitted across the two cells the VT
// assigned it, instead of a lam and an alef crammed one per cell.
//
// A letter outside the presentation-form range (Arabic Supplement, Extended-A,
// and the handful of core code points without forms) has no form to select, so
// it falls back to the zero-width joiner it always used, which joins on Chromium
// and comes back isolated on Firefox. Nothing in the test corpus reaches that
// path; core Arabic does not.
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
 * Contextual forms for the core Arabic letters, from Arabic Presentation
 * Forms-B. Keyed by base code point, each value is [isolated, final, initial,
 * medial]; a 0 means the letter has no form of that shape (a right-joining
 * letter has no initial or medial, so those are 0). A code point absent from the
 * map has no presentation form at all and takes the joiner fallback.
 *
 * The four indices line up with FORM below: iso 0, final 1, initial 2, medial 3.
 */
const FORMS: Readonly<Record<number, readonly [number, number, number, number]>> = {
  0x0621: [0xfe80, 0, 0, 0], // hamza
  0x0622: [0xfe81, 0xfe82, 0, 0], // alef madda
  0x0623: [0xfe83, 0xfe84, 0, 0], // alef hamza above
  0x0624: [0xfe85, 0xfe86, 0, 0], // waw hamza
  0x0625: [0xfe87, 0xfe88, 0, 0], // alef hamza below
  0x0626: [0xfe89, 0xfe8a, 0xfe8b, 0xfe8c], // yeh hamza
  0x0627: [0xfe8d, 0xfe8e, 0, 0], // alef
  0x0628: [0xfe8f, 0xfe90, 0xfe91, 0xfe92], // beh
  0x0629: [0xfe93, 0xfe94, 0, 0], // teh marbuta
  0x062a: [0xfe95, 0xfe96, 0xfe97, 0xfe98], // teh
  0x062b: [0xfe99, 0xfe9a, 0xfe9b, 0xfe9c], // theh
  0x062c: [0xfe9d, 0xfe9e, 0xfe9f, 0xfea0], // jeem
  0x062d: [0xfea1, 0xfea2, 0xfea3, 0xfea4], // hah
  0x062e: [0xfea5, 0xfea6, 0xfea7, 0xfea8], // khah
  0x062f: [0xfea9, 0xfeaa, 0, 0], // dal
  0x0630: [0xfeab, 0xfeac, 0, 0], // thal
  0x0631: [0xfead, 0xfeae, 0, 0], // reh
  0x0632: [0xfeaf, 0xfeb0, 0, 0], // zain
  0x0633: [0xfeb1, 0xfeb2, 0xfeb3, 0xfeb4], // seen
  0x0634: [0xfeb5, 0xfeb6, 0xfeb7, 0xfeb8], // sheen
  0x0635: [0xfeb9, 0xfeba, 0xfebb, 0xfebc], // sad
  0x0636: [0xfebd, 0xfebe, 0xfebf, 0xfec0], // dad
  0x0637: [0xfec1, 0xfec2, 0xfec3, 0xfec4], // tah
  0x0638: [0xfec5, 0xfec6, 0xfec7, 0xfec8], // zah
  0x0639: [0xfec9, 0xfeca, 0xfecb, 0xfecc], // ain
  0x063a: [0xfecd, 0xfece, 0xfecf, 0xfed0], // ghain
  0x0641: [0xfed1, 0xfed2, 0xfed3, 0xfed4], // feh
  0x0642: [0xfed5, 0xfed6, 0xfed7, 0xfed8], // qaf
  0x0643: [0xfed9, 0xfeda, 0xfedb, 0xfedc], // kaf
  0x0644: [0xfedd, 0xfede, 0xfedf, 0xfee0], // lam
  0x0645: [0xfee1, 0xfee2, 0xfee3, 0xfee4], // meem
  0x0646: [0xfee5, 0xfee6, 0xfee7, 0xfee8], // noon
  0x0647: [0xfee9, 0xfeea, 0xfeeb, 0xfeec], // heh
  0x0648: [0xfeed, 0xfeee, 0, 0], // waw
  0x0649: [0xfeef, 0xfef0, 0, 0], // alef maksura
  0x064a: [0xfef1, 0xfef2, 0xfef3, 0xfef4], // yeh
};

/** Index into a FORMS entry, and the join context that selects it. */
const FORM = { ISO: 0, FINAL: 1, INITIAL: 2, MEDIAL: 3 } as const;

/**
 * Lam plus alef is a mandatory ligature: the two letters collapse into one
 * glyph, encoded in Presentation Forms-B. Keyed by the alef code point, each
 * value is [isolated, final]; the final form is used when the lam itself joins
 * to a preceding letter. There is no initial or medial lam-alef.
 */
const LAM = 0x0644;
const LAM_ALEF: Readonly<Record<number, readonly [number, number]>> = {
  0x0622: [0xfef5, 0xfef6], // lam + alef madda
  0x0623: [0xfef7, 0xfef8], // lam + alef hamza above
  0x0625: [0xfef9, 0xfefa], // lam + alef hamza below
  0x0627: [0xfefb, 0xfefc], // lam + alef
};

/**
 * The presentation form for a base letter in a given join context, or 0 if the
 * letter has no form. A letter that joins on a side it has no form for (a
 * right-joining letter asked for a medial) falls back toward the isolated form:
 * medial to final, initial and final to isolated.
 */
function presentationForm(base: number, joinPrev: boolean, joinNext: boolean): number {
  const row = FORMS[base];
  if (row === undefined) return 0;
  let idx = joinPrev && joinNext ? FORM.MEDIAL : joinNext ? FORM.INITIAL : joinPrev ? FORM.FINAL : FORM.ISO;
  let cp = row[idx];
  if (cp === 0 && idx === FORM.MEDIAL) cp = row[FORM.FINAL];
  if (cp === 0) cp = row[FORM.ISO];
  return cp;
}

/** The grapheme's trailing combining marks: everything after its base scalar. */
function marksOf(grapheme: string): string {
  const first = grapheme.codePointAt(0) ?? 0;
  return grapheme.slice(first > 0xffff ? 2 : 1);
}

/**
 * Contextual shaper for the Arabic block.
 *
 * Two things happen to a run, and both are needed for either to be worth doing:
 *
 *   1. Joining. Each letter's initial/medial/final/isolated form is selected
 *      from Presentation Forms-B by its join context and rastered directly, so
 *      the same forms come back on every browser. A lam followed by an alef is
 *      collapsed into its mandatory ligature glyph across the two cells.
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
        // Each side asks two questions: can this letter take a joined form on
        // that side, and does the neighbour offer a connection on the facing
        // side. The two are not the same predicate. Alef only joins backward,
        // so it cannot start a connection to the letter after it but it does
        // accept one from the letter before it, which is what makes the lam in
        // salaam medial rather than final. A transparent cell (a lone combining
        // mark in its own cell) is not a letter and gets no context of its own.
        const joinPrev =
          jt !== Joining.T && joinsBackward(jt) && joinsForward(prevBase(base, i));
        const joinNext =
          jt !== Joining.T && joinsForward(jt) && joinsBackward(nextBase(base, i));

        // Lam followed by an alef variant is the one mandatory ligature: the two
        // cells become a single glyph. The final ligature form is used when the
        // lam itself joins to a preceding letter. The glyph is placed in the
        // alef's reordered column, the left of the two, and spans both; the lam's
        // own column is blanked so its base letter is not drawn again underneath.
        const lig = base[i] === LAM && i + 1 < n ? LAM_ALEF[base[i + 1]] : undefined;
        if (lig !== undefined) {
          const cp = joinPrev ? lig[1] : lig[0];
          const c = String.fromCodePoint(cp) + marksOf(cells[i]) + marksOf(cells[i + 1]);
          glyphs.push({
            atlasKey: 'ar\u0001' + styleTag + 'L\u0001' + c,
            cluster: c,
            col: reorder(base, i + 1),
            xOffset: 0,
            rtl: false,
            fitAdvance: true,
            cols: 2,
          });
          glyphs.push({
            atlasKey: 'arblank',
            cluster: '',
            col: reorder(base, i),
            xOffset: 0,
            rtl: false,
            fitAdvance: false,
          });
          i++;
          continue;
        }

        // A letter with nothing to join to keeps its own code point and its
        // natural advance: it is not remapped to a form and not fitted, so a
        // hamza, a digit or a lone alef rasters exactly as it does with no shaper.
        // Fitting exists only so a joining letter's connecting stroke meets its
        // neighbour's on the cell boundary.
        const joined = joinPrev || joinNext;
        const form = joined ? presentationForm(base[i], joinPrev, joinNext) : 0;
        // A form selected directly needs no joining context to resolve, so its
        // raster is engine-independent and needs no right-to-left context. A
        // joining letter with no form (Arabic Supplement, Extended-A, tatweel)
        // falls back to the zero-width joiner, which Chromium resolves under a
        // right-to-left context and Firefox leaves isolated.
        const cluster =
          form !== 0
            ? String.fromCodePoint(form) + marksOf(cells[i])
            : (joinPrev ? ZWJ : '') + cells[i] + (joinNext ? ZWJ : '');
        const rtl = form !== 0 ? false : joined;
        glyphs.push({
          // Namespaced away from the default path's `grapheme + mask` keys on
          // purpose: a fitted raster of a letter is not interchangeable with the
          // plain one, and sharing a key would poison the unshaped entry.
          atlasKey: 'ar\u0001' + styleTag + (joined ? 'j' : '') + '\u0001' + cluster,
          cluster,
          col: reorder(base, i),
          xOffset: 0,
          rtl,
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
