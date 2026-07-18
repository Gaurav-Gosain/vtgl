// Grapheme torture corpus.
//
// One entry per hard case in Unicode text rendering, each with the cell layout
// it must occupy. These drive two different assertions:
//
//   1. Cell-grid agreement. A real VT (ghostty-vt) segments and measures these
//      clusters itself. `columns` records what a correct grapheme-aware VT
//      reports, so a host adapter can be checked against it.
//   2. Pixel parity. Both renderer backends must draw the corpus identically,
//      which is what catches an atlas that splits a cluster or drops a mark.
//
// `columns` is the number of terminal columns the cluster occupies, and is the
// property the renderer must honour: a width-2 cluster gets a width-2 head and
// a width-0 spacer tail, and the glyph must not be clipped to one cell.

import { FakeSource } from './fake-source.ts';
import type { Rgb } from '../types.ts';

export interface TortureEntry {
  name: string;
  /** The grapheme cluster as a single string. */
  text: string;
  /** Terminal columns the cluster occupies. */
  columns: number;
  /** Scalar count, to prove the cluster is not being split per code point. */
  scalars: number;
  /** What this case is actually testing. */
  note: string;
  /**
   * The cell layout ghostty-vt actually produces for this cluster, measured
   * against the real wasm rather than assumed:
   *
   *   'wide'  a width-N head carrying the whole grapheme, then N-1 width-0
   *           spacer tails. Every 2-column cluster here takes this shape,
   *           including the Devanagari conjunct ksha.
   *   'split' one width-1 cell per scalar. This is what Arabic gets, which is
   *           why contextual joining needs a shaper working across cells
   *           rather than a wider atlas slot.
   */
  layout: 'wide' | 'split';
}

export const tortureCorpus: TortureEntry[] = [
  // --- wide East Asian ---
  { name: 'cjk-han',
    layout: 'wide', text: '世', columns: 2, scalars: 1, note: 'Wide Han ideograph.' },
  { name: 'cjk-kana',
    layout: 'wide', text: 'あ', columns: 2, scalars: 1, note: 'Wide hiragana.' },
  {
    name: 'hangul-syllable',
    layout: 'wide',
    text: '한',
    columns: 2,
    scalars: 1,
    note: 'Precomposed Hangul syllable.',
  },
  {
    name: 'fullwidth-latin',
    layout: 'wide',
    text: 'Ａ',
    columns: 2,
    scalars: 1,
    note: 'Fullwidth Latin: wide despite being Latin.',
  },
  {
    name: 'halfwidth-kana',
    layout: 'split',
    text: 'ｱ',
    columns: 1,
    scalars: 1,
    note: 'Halfwidth kana: narrow despite being kana.',
  },

  // --- emoji, presentation and ZWJ ---
  {
    name: 'emoji-simple',
    layout: 'wide',
    text: '😀',
    columns: 2,
    scalars: 1,
    note: 'Single-scalar emoji with default emoji presentation.',
  },
  {
    name: 'emoji-zwj-family',
    layout: 'wide',
    text: '👨‍👩‍👧‍👦',
    columns: 2,
    scalars: 7,
    note: 'Four people joined by three ZWJs; must render as one cluster, not four.',
  },
  {
    name: 'emoji-zwj-profession',
    layout: 'wide',
    text: '👩‍💻',
    columns: 2,
    scalars: 3,
    note: 'Person + ZWJ + object.',
  },
  {
    name: 'emoji-skin-tone',
    layout: 'wide',
    text: '👍🏽',
    columns: 2,
    scalars: 2,
    note: 'Base emoji + Fitzpatrick modifier; the modifier must not get its own cell.',
  },
  {
    name: 'emoji-flag',
    layout: 'wide',
    text: '🇯🇵',
    columns: 2,
    scalars: 2,
    note: 'Regional indicator pair; two scalars, one flag, one cluster.',
  },
  {
    name: 'emoji-tag-flag',
    layout: 'wide',
    text: '🏴󠁧󠁢󠁳󠁣󠁴󠁿',
    columns: 2,
    scalars: 7,
    note: 'Tag sequence flag (Scotland): black flag plus tag characters.',
  },
  {
    name: 'emoji-keycap',
    layout: 'wide',
    text: '1️⃣',
    columns: 2,
    scalars: 3,
    note: 'Digit + VS16 + combining enclosing keycap.',
  },
  {
    name: 'emoji-zwj-rainbow',
    layout: 'wide',
    text: '🏳️‍🌈',
    columns: 2,
    scalars: 4,
    note: 'Flag + VS16 + ZWJ + rainbow.',
  },

  // --- variation selectors ---
  {
    name: 'vs16-emoji-presentation',
    layout: 'wide',
    text: '❤️',
    columns: 2,
    scalars: 2,
    note: 'VS16 forces emoji presentation, which widens the cluster to 2 columns.',
  },
  {
    name: 'vs15-text-presentation',
    layout: 'split',
    text: '❤︎',
    columns: 1,
    scalars: 2,
    note: 'VS15 forces text presentation, which keeps the cluster narrow.',
  },

  // --- combining marks ---
  {
    name: 'combining-acute',
    layout: 'split',
    // Written as escapes deliberately: a literal here is liable to be
    // normalized to precomposed U+00E9 by an editor, which tests nothing.
    text: 'e\u0301',
    columns: 1,
    scalars: 2,
    note: 'e + combining acute: zero-width mark must stay on its base cell.',
  },
  {
    name: 'combining-stack',
    layout: 'split',
    text: 'e\u0323\u0300\u0301',
    columns: 1,
    scalars: 4,
    note: 'Multiple stacked combining marks on one base.',
  },
  {
    name: 'combining-zalgo',
    layout: 'split',
    text: 'a\u0300\u0301\u0302\u0303\u0308\u030a\u0323\u0324\u0325\u0330\u0331',
    columns: 1,
    scalars: 12,
    note: 'Pathological mark stack; must not spill into neighbouring cells.',
  },

  // --- Indic ---
  {
    name: 'devanagari-ksha',
    layout: 'wide',
    text: '\u0915\u094d\u0937',
    columns: 2,
    scalars: 3,
    note: 'Devanagari conjunct ksha: consonant + virama + consonant. The virama is a non-spacing mark, so the terminal grid answer is 2 columns even though correct typography is a single conjunct glyph.',
  },
  {
    name: 'devanagari-consonant',
    layout: 'split',
    text: '\u0928',
    columns: 1,
    scalars: 1,
    note: 'Single Devanagari consonant, no conjunct.',
  },
  {
    name: 'devanagari-matra',
    layout: 'wide',
    text: '\u0928\u093f',
    columns: 2,
    scalars: 2,
    note: 'Consonant + dependent vowel sign. U+093F is a spacing combining mark, and ghostty-vt reports the cluster as a width-2 head plus a spacer tail rather than a single column. Verified against the real VT, which is why this says 2: the intuitive answer of 1 is wrong.',
  },

  // --- Arabic ---
  {
    name: 'arabic-isolated',
    layout: 'split',
    text: '\u0627',
    columns: 1,
    scalars: 1,
    note: 'Isolated alef.',
  },
  {
    name: 'arabic-word',
    layout: 'split',
    text: '\u0633\u0644\u0627\u0645',
    columns: 4,
    scalars: 4,
    note: 'Arabic word: four cells, but correct rendering needs contextual joining across them. vtgl has no shaper, so each letter draws in isolated form. This is the known limitation.',
  },
  {
    name: 'arabic-lam-alef',
    layout: 'split',
    text: '\u0644\u0627',
    columns: 2,
    scalars: 2,
    note: 'Lam + alef, which shapes to a single ligature glyph in a real shaper.',
  },
];

/** Corpus entries that a contextual shaper would be required to render right. */
export const shapingRequired = new Set(['arabic-word', 'arabic-lam-alef']);

/**
 * Lay the corpus into a FakeSource, one entry per row, using each entry's
 * declared column count rather than FakeSource's own width heuristic. The point
 * is to feed the renderer exactly the cell geometry a real grapheme-aware VT
 * would report, so what is under test is the renderer and not the test double.
 *
 * A multi-column cluster is written as a width-N head carrying the whole
 * grapheme string followed by N-1 width-0 spacer tails, which is the ghostty-vt
 * cell model.
 */
export function buildTortureSource(opts: {
  cols?: number;
  fg?: Rgb;
  bg?: Rgb;
} = {}): FakeSource {
  const cols = opts.cols ?? 40;
  const s = new FakeSource({
    cols,
    rows: tortureCorpus.length,
    fg: opts.fg ?? 0xd0d0d0,
    bg: opts.bg ?? 0x101010,
  });
  s.setCursor({ visible: false });
  s.clearRegion(0, tortureCorpus.length);
  tortureCorpus.forEach((entry, row) => {
    // Repeat the cluster across the row so a per-cell bug shows up as a
    // pattern rather than as one easily-missed cell.
    let col = 0;
    while (col + entry.columns <= cols) {
      writeCluster(s, row, col, entry);
      col += entry.columns + 1; // one blank between repeats
    }
  });
  return s;
}

function writeCluster(s: FakeSource, row: number, col: number, entry: TortureEntry): void {
  if (entry.layout === 'split') {
    // One width-1 cell per scalar, which is what ghostty-vt does for Arabic and
    // for lone combining sequences.
    const parts = [...entry.text];
    if (entry.columns === 1) {
      // A single cell carrying the whole cluster, marks included.
      s.setCell(row, col, entry.text.codePointAt(0)!, { width: 1, grapheme: entry.text });
      return;
    }
    for (let i = 0; i < entry.columns; i++) {
      s.setCell(row, col + i, parts[i].codePointAt(0)!, {
        width: 1,
        grapheme: parts[i],
      });
    }
    return;
  }
  // Wide cluster: width-N head carrying the full grapheme, then spacer tails.
  s.setCell(row, col, entry.text.codePointAt(0)!, {
    width: entry.columns,
    grapheme: entry.text,
  });
  for (let i = 1; i < entry.columns; i++) {
    s.setCell(row, col + i, 0, { width: 0 });
  }
}

