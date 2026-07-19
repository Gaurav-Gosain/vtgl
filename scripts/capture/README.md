# capture

Produces the README images in `docs/images`, apart from the banner (see
[../banner](../banner)).

```sh
npm run capture
```

Requires the system chromium (or `VTGL_CHROMIUM` pointing at one), and reads the
fonts installed on the machine.

## What it makes

| file | what it is |
| --- | --- |
| `demo.png` | a terminal frame: the real output of `git log --graph` and `npm test`, run in this repo |
| `unicode.png` | the 24-entry grapheme torture corpus from `src/testing/torture.ts`, at 1:1 |
| `atlas.png` | the glyph atlas page that drew `unicode.png`, read back off the GPU |

## Reproducibility

`unicode.png` and `atlas.png` are byte-reproducible: their content comes from
the torture corpus and the packer, so re-running produces the committed bytes.

`demo.png` is not, and deliberately so. It embeds the live output of `git log
--graph --oneline -8` and `npm test`, so every new commit and every run's test
timings change the frame. That is the point of the shot, but it means the glyph
count quoted in the README caption describes the committed frame rather than
whatever the next run produces. Re-capture and update that number together, or
leave the committed frame alone.

## Rules

Every pixel is the real `WebGL2Renderer` drawing into a real WebGL2 context.
Node's only job is deciding which cells exist; it never draws. There is no
mockup, no compositing, and no retouching, and a command that exits non-zero
still has its output drawn rather than being quietly dropped.

`atlas.png` in particular is the actual texture: the atlas layer is attached to
a framebuffer and read with `readPixels`, and the slot rectangles drawn over it
come from the packer's own entry map. Re-rasterizing the glyphs into a separate
canvas would have been easier and would have produced a picture of an atlas
rather than a picture of *the* atlas.

The capture harness reaches past `private` into the renderer's `gl` and `atlas`
fields to do that. That is the one liberty taken here, and it is taken so the
image is evidence instead of illustration.

## The font stack

`"JetBrainsMono Nerd Font Mono", "Noto Sans CJK JP", "DejaVu Sans", "Noto Color
Emoji", monospace`.

DejaVu sits ahead of the emoji font deliberately. JetBrains Mono has no U+2714
or U+2139, which node's test reporter prints; with only an emoji font behind it,
chromium falls back to Noto Color Emoji and hands back an emoji-sized glyph for
a slot the width table sized at one column, which vtgl then clips (see
`docs/limits.md`, "Wide glyphs clip rather than bleed"). DejaVu carries the same
codepoints at text metrics, so they fit the cell they were assigned.

Two things in `unicode.png` are font limits rather than renderer limits, and are
left visible rather than tuned away:

- The four-person ZWJ family has no glyph in this build of Noto Color Emoji.
  Chromium substitutes a composed monochrome fallback, which at terminal size
  reads as a pale box. Other ZWJ sequences, including the 7-scalar Scotland tag
  flag, compose correctly.
- Arabic draws in isolated forms. That one is vtgl: it ships no shaper.
