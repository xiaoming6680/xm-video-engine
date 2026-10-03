// Chinese text support. The video is Chinese-first: every Latin family falls back glyph by glyph to its
// Chinese stand-in (Canvas2D font lists, see type.ts font()), and the Chinese faces always load.

/** Always on: Chinese glyphs fall back to 思源黑体 / 思源宋体 (kept as a flag for the ported pdoom engine code). */
export const ZH = true;

/**
 * The Chinese face standing in for a Latin family's missing glyphs: 思源黑体 for Archivo and Plex Mono at the
 * nearest weight, 思源宋体 for Cormorant. The faces are subsets of the system Noto Sans SC / Noto Serif SC
 * (OFL) made by analysis/make_fonts_zh.py.
 */
export function cjkFor(family: string): string {
  if (family.startsWith('Noto')) return family;
  const wt = +(/-(\d+)$/.exec(family)?.[1] ?? 400);
  if (family.startsWith('Cormorant')) return wt < 500 ? 'NotoSerifSC-400' : 'NotoSerifSC-600';
  // Archivo 300/500/700/900, its italics 400/800, Plex 300–700
  const w = wt < 350 ? 300 : wt < 450 ? 400 : wt < 650 ? 500 : wt < 800 ? 700 : 900;
  return `NotoSansSC-${w}`;
}

/** Every Chinese face (file = public/fonts/<family>.ttf). */
export const CJK_FAMILIES = ['NotoSansSC-300', 'NotoSansSC-400', 'NotoSansSC-500', 'NotoSansSC-700', 'NotoSansSC-900', 'NotoSerifSC-400', 'NotoSerifSC-600'];
