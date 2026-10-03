import { hexToLinear } from './util';

// The project palette: every project sets its own colours here (the key names stay: glsl/common.ts bakes them into
// GLSL constants C_INK, C_BONE, C_SIGNAL …). Defaults are pdoom's: ink, bone, and one signal colour.
// Only signal/ember are meant to glow (linear values above ~0.85 bloom).
export const HEX = {
  ink: '#0A0A0B', // background black (slightly warm)
  ink2: '#151517', // raised black (panels, paper-in-the-dark)
  graphite: '#5E5B57', // dim lines, secondary text
  ash: '#9C978F', // mid grey
  bone: '#EEE9DF', // paper white, primary text
  signal: '#FF4D12', // the one strong colour (pdoom: hazard orange; Falling_Again: VALORANT red #FF4655)
  ember: '#FF8A3D', // hotter, lighter core of the signal
  blood: '#C21D0B', // deep shadow of the signal
  acid: '#D8FF3C', // spare accent
} as const;

export type PaletteKey = keyof typeof HEX;

/** Linear RGB triplets for GL uniforms. */
export const LIN: Record<PaletteKey, [number, number, number]> = Object.fromEntries(
  Object.entries(HEX).map(([k, v]) => [k, hexToLinear(v)]),
) as Record<PaletteKey, [number, number, number]>;

/** CSS rgba() for Canvas2D. */
export function rgba(key: PaletteKey | string, a = 1): string {
  const hex = (HEX as Record<string, string>)[key] ?? key;
  const n = parseInt(hex.replace('#', ''), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}
