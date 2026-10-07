// Character-grid rendering ("ASCII art"): a picture becomes glyphs on a grid, each cell's glyph chosen by the
// picture's brightness there (glyphs sorted by their measured ink coverage). Draw the subject as plain shapes or
// a 3D scene into a render target, then hand its texture to Ascii.render(): the shapes come out made of characters
// with the rows of the grid showing between them (the kaomoji.exe boot face, the CRT ring tunnel).
//   const asc = new Ascii({ chars: ' .:-=+*#%@' });            // in the scene's init (fonts are loaded by then)
//   asc.render(renderer, picRT.texture, out, { cell: 16, mode: 'color', boost: 1.6 });
// mode 'mono' paints every glyph in one phosphor colour (ink), 'color' takes each cell's own colour (normalised, so
// a dim red area still gives red glyphs: the density carries the brightness). Pure function of its inputs.
// Method after lemo-opuscar's ascii-crt STYLE.md (MIT, LemoLab): measured ink ramp, blank cells for darks, ordered dither.
import * as THREE from 'three';
import { FSPass, W, H } from './gl';
import { F, font } from './type';

export interface AsciiOpts {
  /** Cell height in logical px (the width follows the font's advance). Default 18. */
  cell?: number;
  /** 'color': glyphs take the picture's colour; 'mono': all glyphs in `ink`. */
  mode?: 'color' | 'mono';
  /** Mono glyph colour (linear). */
  ink?: [number, number, number];
  /** Background (linear). */
  paper?: [number, number, number];
  /** Brightness -> density: gain and gamma (gamma < 1 fills mid-tones). */
  gain?: number;
  gamma?: number;
  /** Cells darker than this stay blank (negative space makes ASCII art readable). */
  threshold?: number;
  /** 0..1 ordered dither between neighbouring ramp steps. */
  dither?: number;
  /** Glyph brightness multiplier (> 1 blooms). */
  boost?: number;
  /** Grid offset in logical px (scroll the grid, or push in with `cell`). */
  offset?: [number, number];
}

/**
 * Glyphs sorted by measured ink coverage, drawn white in one row of cells (64 px tall) — shared by Ascii (picture ->
 * grid) and kit/glyphfield.ts (glyph particles). `ramp[0]` is always the space. Cell i spans u in [i/n, (i+1)/n).
 */
export class GlyphAtlas {
  readonly ramp: string[];
  /** Ink coverage of each ramp glyph (0..1, ascending). */
  readonly cover: number[];
  /** Cell width / height. */
  readonly aspect: number;
  readonly texture: THREE.CanvasTexture;
  get n() { return this.ramp.length; }
  constructor(o: { chars?: string; family?: string } = {}) {
    const chars = o.chars ?? " .'`,:;-~=+*!?/|()[]{}<>il1tfjrxnuvczXYUJCLQ0OZmwqpdbkhao#MW&8%B@$";
    const family = o.family ?? F.mono(500);
    const AH = 64, seg = new Intl.Segmenter('ja', { granularity: 'grapheme' });
    const cand = [...new Set([' ', ...[...seg.segment(chars)].map((s) => s.segment)])];
    // measure the advance and each glyph's ink coverage
    const m = document.createElement('canvas').getContext('2d', { willReadFrequently: true })!;
    m.font = font(family, AH * 0.86);
    const adv = Math.max(...cand.map((ch) => m.measureText(ch).width), AH * 0.4);
    const AW = Math.ceil(adv);
    this.aspect = AW / AH;
    const probe = document.createElement('canvas');
    probe.width = AW; probe.height = AH;
    const pc = probe.getContext('2d', { willReadFrequently: true })!;
    const cover = (ch: string) => {
      pc.clearRect(0, 0, AW, AH);
      pc.font = m.font; pc.fillStyle = '#fff'; pc.textAlign = 'center'; pc.textBaseline = 'middle';
      pc.fillText(ch, AW / 2, AH * 0.54);
      const d = pc.getImageData(0, 0, AW, AH).data;
      let s = 0;
      for (let i = 3; i < d.length; i += 4) s += d[i]!;
      return s / (255 * AW * AH);
    };
    const measured = cand.map((ch) => ({ ch, c: ch === ' ' ? 0 : cover(ch) })).filter((g) => g.ch === ' ' || g.c > 0.002);
    measured.sort((a, b) => a.c - b.c);
    const ramp: { ch: string; c: number }[] = [];
    for (const g of measured) if (!ramp.length || g.c - ramp[ramp.length - 1]!.c > 0.004) ramp.push(g);
    this.ramp = ramp.map((g) => g.ch);
    this.cover = ramp.map((g) => g.c);
    // the atlas: one row of cells, white glyphs on transparent, in ramp order
    const atlas = document.createElement('canvas');
    atlas.width = AW * ramp.length; atlas.height = AH;
    const ac = atlas.getContext('2d')!;
    ac.font = m.font; ac.fillStyle = '#fff'; ac.textAlign = 'center'; ac.textBaseline = 'middle';
    ramp.forEach((g, i) => ac.fillText(g.ch, AW * i + AW / 2, AH * 0.54));
    this.texture = new THREE.CanvasTexture(atlas);
    this.texture.colorSpace = THREE.NoColorSpace;   // coverage, not colour
    this.texture.minFilter = THREE.LinearMipmapLinearFilter;
    this.texture.generateMipmaps = true;
    this.texture.anisotropy = 4;
  }
  /** Ramp index for a brightness 0..1 (0 = space). */
  level(l: number) { return l <= 0 ? 0 : Math.min(this.n - 1, Math.max(1, Math.round(l * (this.n - 1)))); }
}

export class Ascii {
  readonly glyphs: GlyphAtlas;
  get ramp() { return this.glyphs.ramp; }
  get aspect() { return this.glyphs.aspect; }
  private pass: FSPass;

  /**
   * `chars`: candidate glyphs (any order; sorted by ink, near-duplicates dropped; a space is always the first step).
   * `family`: a Canvas2D family (default IBM Plex Mono 500; CJK and kaomoji glyphs fall back to Noto Sans SC).
   */
  constructor(o: { chars?: string; family?: string } = {}) {
    this.glyphs = new GlyphAtlas(o);
    const ramp = this.glyphs.ramp;
    this.pass = new FSPass(/* glsl */ `
      uniform sampler2D src, atlas; uniform vec2 cellPx, gridOff, res; uniform float n, gain, gam, thr, dither, boost, mono;
      uniform vec3 ink, paper;
      void main() {
        vec2 px = FRAG_PX + gridOff;
        vec2 cid = floor(px / cellPx), inC = fract(px / cellPx);
        // the cell's colour: 4 taps inside it
        vec3 c = vec3(0.0);
        for (int j = 0; j < 2; j++) for (int i = 0; i < 2; i++)
          c += texture(src, ((cid + vec2(0.25 + 0.5 * float(i), 0.25 + 0.5 * float(j))) * cellPx - gridOff) / res).rgb;
        c *= 0.25;
        float l = pow(max(luma(c) * gain, 0.0), gam);
        l += (hash12(cid * 1.37 + 3.1) - 0.5) * dither / max(n - 1.0, 1.0);
        float gi = l < thr ? 0.0 : clamp(floor(l * (n - 1.0) + 0.5), 1.0, n - 1.0);
        float cov = texture(atlas, vec2((gi + inC.x) / n, inC.y)).a;
        float mx = max(max(c.r, c.g), c.b);
        vec3 gc = mono > 0.5 ? ink * (0.55 + 0.45 * sat(l)) : c / max(mx, 0.04) * (0.5 + 0.5 * sat(mx * 2.0));
        fragColor = vec4(mix(paper, gc * boost, cov), 1.0);
      }`, {
      src: { value: null }, atlas: { value: this.glyphs.texture }, cellPx: { value: new THREE.Vector2() }, gridOff: { value: new THREE.Vector2() },
      res: { value: new THREE.Vector2(W, H) }, n: { value: ramp.length }, gain: { value: 1 }, gam: { value: 1 }, thr: { value: 0.04 },
      dither: { value: 0.6 }, boost: { value: 1 }, mono: { value: 0 }, ink: { value: new THREE.Vector3() }, paper: { value: new THREE.Vector3() },
    });
  }

  render(renderer: THREE.WebGLRenderer, src: THREE.Texture, out: THREE.WebGLRenderTarget, o: AsciiOpts = {}) {
    const u = this.pass.u, cell = o.cell ?? 18;
    u.src!.value = src;
    (u.cellPx!.value as THREE.Vector2).set(cell * this.aspect, cell);
    (u.gridOff!.value as THREE.Vector2).set(...(o.offset ?? [0, 0]));
    u.gain!.value = o.gain ?? 1;
    u.gam!.value = o.gamma ?? 1;
    u.thr!.value = o.threshold ?? 0.04;
    u.dither!.value = o.dither ?? 0.6;
    u.boost!.value = o.boost ?? 1;
    u.mono!.value = o.mode === 'mono' ? 1 : 0;
    (u.ink!.value as THREE.Vector3).set(...(o.ink ?? [0.2, 1.0, 0.45]));
    (u.paper!.value as THREE.Vector3).set(...(o.paper ?? [0, 0, 0]));
    this.pass.render(renderer, out);
  }
}
