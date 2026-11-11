import { hexToLinear } from './util';

// The project palette: every project sets its own colours here (the key names stay: glsl/common.ts bakes them into
// GLSL constants C_INK, C_BONE, C_SIGNAL …). The defaults are neutral placeholders (greys and one plain blue),
// not a look: choose the film's colours here first.
export const HEX = {
  ink: '#0B0B0C', // background black
  ink2: '#18181B', // raised black (panels)
  graphite: '#5F5F66', // dim lines, secondary text
  ash: '#9E9EA6', // mid grey
  bone: '#F5F5F3', // white, primary text
  signal: '#2F6BFF', // the one strong colour
  ember: '#7FA6FF', // lighter tint of the signal
  blood: '#1A3FA8', // deep shade of the signal
  acid: '#FFC53D', // spare accent
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
