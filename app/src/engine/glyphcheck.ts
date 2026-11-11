// Missing-glyph check (?glyphcheck, `render.ts glyphs`): every string drawn with Canvas2D fillText / strokeText,
// and every text outline from type.ts, is checked against the fonts the engine registered (type.ts, config.ts
// EXTRA_FONTS, the Chinese stand-ins). A character that none of the listed families has falls back to a system
// font in Canvas2D (another style, silently) and comes out blank as an outline. Reported with the scene and time.
import { hasGlyph, outlineMiss } from './type';

/** The scene being drawn (set by the engine), so a miss can say where it happened. */
export const glyphScope = { id: '', t: 0 };

interface Miss { ch: string; code: string; fonts: Set<string>; scenes: Set<string>; first: number; n: number; how: string }
const misses = new Map<string, Miss>();
const cache = new Map<string, boolean>();

/** The family list of a CSS font shorthand ('700 48px "Archivo-1000-700", "NotoSansSC-700"' → both names). */
export function families(cssFont: string): string[] {
  const m = /(?:^|\s)[\d.]+(?:e[-+]?\d+)?(?:px|pt|em|rem|%)(?:\s*\/\s*[\d.]+\w*)?\s+(.+)$/i.exec(cssFont.trim());
  return (m ? m[1]! : cssFont).split(',').map((f) => f.trim().replace(/^["']|["']$/g, '')).filter(Boolean);
}

/** Is ch drawn by one of the listed families (the first that is ours decides; a family that is not ours = system font)? */
function covered(fams: string[], ch: string): boolean {
  const key = `${fams.join('|')}\u0000${ch}`;
  let ok = cache.get(key);
  if (ok === undefined) {
    ok = false;
    for (const f of fams) {
      const h = hasGlyph(f, ch);
      if (h === null) break;            // not one of ours: the browser falls back to whatever it has
      if (h) { ok = true; break; }
    }
    cache.set(key, ok);
  }
  return ok;
}

function note(ch: string, fontDesc: string, how: string) {
  const k = `${ch}\u0000${how}`;
  let m = misses.get(k);
  if (!m) misses.set(k, (m = { ch, code: `U+${ch.codePointAt(0)!.toString(16).toUpperCase().padStart(4, '0')}`, fonts: new Set(), scenes: new Set(), first: glyphScope.t, n: 0, how }));
  m.fonts.add(fontDesc);
  m.scenes.add(glyphScope.id || '?');
  m.n++;
}

/** Check one drawn string. */
export function checkText(text: string, cssFont: string) {
  const fams = families(cssFont);
  for (const ch of Array.from(String(text))) {
    if (!ch.trim() || ch.codePointAt(0)! < 0x20 || /[​-‏︎️]/.test(ch)) continue;
    if (!covered(fams, ch)) note(ch, fams.join(', '), 'Canvas2D → 系统字体');
  }
}

/** Patch Canvas2D text drawing (also OffscreenCanvas) and the outline builder; call once before the scenes load. */
export function installGlyphCheck() {
  const protos: any[] = [CanvasRenderingContext2D.prototype];
  if (typeof OffscreenCanvasRenderingContext2D !== 'undefined') protos.push(OffscreenCanvasRenderingContext2D.prototype);
  for (const P of protos) {
    for (const fn of ['fillText', 'strokeText'] as const) {
      const orig = P[fn];
      P[fn] = function (this: CanvasRenderingContext2D, text: string, ...rest: unknown[]) {
        checkText(text, this.font);
        return orig.call(this, text, ...rest);
      };
    }
  }
  outlineMiss.hook = (ch, family) => note(ch, family, '轮廓 → 空白');
}

/** Everything missed so far, most frequent first. */
export function glyphReport() {
  return [...misses.values()].sort((a, b) => b.n - a.n).map((m) => ({
    ch: m.ch, code: m.code, how: m.how, fonts: [...m.fonts], scenes: [...m.scenes], first: m.first, n: m.n,
  }));
}
