import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// Parses src/tokens.css and asserts WCAG 2.x contrast for the semantic pairs the
// UI relies on, in both themes. Translucent colours are composited over the
// surface they sit on before measuring.
const css = readFileSync(new URL('./tokens.css', import.meta.url), 'utf8');

type Rgba = { r: number; g: number; b: number; a: number };

function block(selector: string): Record<string, string> {
  const start = css.indexOf(`${selector} {`);
  if (start < 0) throw new Error(`Missing token block ${selector}`);
  const body = css.slice(css.indexOf('{', start) + 1, css.indexOf('}', start));
  const tokens: Record<string, string> = {};
  for (const match of body.matchAll(/--([\w-]+):\s*([^;]+);/g)) tokens[match[1]] = match[2].trim();
  return tokens;
}

function oklch(value: string): Rgba {
  const match = /^oklch\(([\d.]+)%\s+([\d.]+)\s+([\d.]+)(?:\s*\/\s*([\d.]+))?\)$/.exec(value);
  if (!match) throw new Error(`Not a literal oklch colour: ${value}`);
  const l = Number(match[1]) / 100, c = Number(match[2]), h = (Number(match[3]) * Math.PI) / 180;
  const a = c * Math.cos(h), b = c * Math.sin(h);
  const l_ = (l + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m_ = (l - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s_ = (l - 0.0894841775 * a - 1.291485548 * b) ** 3;
  const clamp = (v: number) => Math.min(1, Math.max(0, v));
  return {
    r: clamp(4.0767416621 * l_ - 3.3077115913 * m_ + 0.2309699292 * s_),
    g: clamp(-1.2684380046 * l_ + 2.6097574011 * m_ - 0.3413193965 * s_),
    b: clamp(-0.0041960863 * l_ - 0.7034186147 * m_ + 1.707614701 * s_),
    a: match[4] === undefined ? 1 : Number(match[4]),
  };
}

const over = (top: Rgba, bottom: Rgba): Rgba => ({
  r: top.r * top.a + bottom.r * (1 - top.a),
  g: top.g * top.a + bottom.g * (1 - top.a),
  b: top.b * top.a + bottom.b * (1 - top.a),
  a: 1,
});
const luminance = (c: Rgba) => 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b; // already linear
const ratio = (x: Rgba, y: Rgba) => {
  const [hi, lo] = [luminance(x), luminance(y)].sort((p, q) => q - p);
  return (hi + 0.05) / (lo + 0.05);
};

const themes = {
  dark: block(':root, [data-theme="dark"]'),
  light: { ...block(':root, [data-theme="dark"]'), ...block('[data-theme="light"]') },
};

function contrast(theme: Record<string, string>, fg: string, bg: string, base = 'canvas') {
  const ground = oklch(theme[base]);
  const background = over(oklch(theme[bg]), ground);
  return ratio(over(oklch(theme[fg]), background), background);
}

describe.each(Object.entries(themes))('%s theme tokens', (_name, theme) => {
  const surfaces = ['canvas', 'surface-1', 'surface-2', 'surface-3', 'inset'];

  it.each(surfaces)('body text tiers stay readable on %s', surface => {
    expect(contrast(theme, 'text-1', surface)).toBeGreaterThanOrEqual(7);
    expect(contrast(theme, 'text-2', surface)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(theme, 'text-3', surface)).toBeGreaterThanOrEqual(4.5);
  });

  it.each(['accent-text', 'evidence', 'success', 'warning', 'danger', 'info', 'restricted'])('%s tone text meets AA on surfaces and its tint', tone => {
    for (const surface of surfaces) expect(contrast(theme, tone, surface), `${tone} on ${surface}`).toBeGreaterThanOrEqual(4.5);
    const tint = tone === 'accent-text' ? 'accent-subtle' : `${tone}-bg`;
    expect(contrast(theme, tone, tint, 'surface-2'), `${tone} on ${tint}`).toBeGreaterThanOrEqual(4.5);
  });

  it('text on filled accent and danger buttons meets AA in every state', () => {
    for (const fill of ['accent', 'accent-hover', 'accent-pressed']) expect(contrast(theme, 'on-accent', fill), fill).toBeGreaterThanOrEqual(4.5);
    expect(contrast(theme, 'on-accent', 'danger-fill')).toBeGreaterThanOrEqual(4.5);
  });

  it('focus ring is a visible non-text indicator against every surface', () => {
    for (const surface of surfaces) expect(contrast(theme, 'ring', surface), surface).toBeGreaterThanOrEqual(3);
  });

  it('control borders separate inputs from their surroundings', () => {
    // Inputs also differ by fill; the border alone is held to 2.5:1 by design.
    for (const surface of ['canvas', 'surface-1', 'surface-2']) expect(contrast(theme, 'border-control', surface), surface).toBeGreaterThanOrEqual(2.5);
  });

  it('reading surface keeps extracted text at AAA', () => {
    expect(contrast(theme, 'reading-text', 'reading-surface')).toBeGreaterThanOrEqual(7);
    expect(contrast(theme, 'reading-muted', 'reading-surface')).toBeGreaterThanOrEqual(4.5);
  });

  it.each(['speaker-1', 'speaker-2', 'speaker-3', 'speaker-4', 'speaker-5', 'speaker-6'])('%s lane is distinguishable from the inset track', speaker => {
    expect(contrast(theme, speaker, 'inset')).toBeGreaterThanOrEqual(3);
  });
});

describe('token hygiene', () => {
  it('each semantic colour is declared once per theme block', () => {
    for (const selector of [':root, [data-theme="dark"]', '[data-theme="light"]']) {
      const start = css.indexOf(`${selector} {`);
      const body = css.slice(css.indexOf('{', start) + 1, css.indexOf('}', start));
      const names = [...body.matchAll(/--([\w-]+):/g)].map(match => match[1]);
      expect(new Set(names).size, selector).toBe(names.length);
    }
  });

  it('the light theme overrides every dark colour role', () => {
    const dark = Object.keys(block(':root, [data-theme="dark"]')).filter(name => name !== 'shadow-raised');
    const light = block('[data-theme="light"]');
    expect(dark.filter(name => !(name in light))).toEqual([]);
  });

  it('no stylesheet other than tokens.css defines colour tokens', () => {
    for (const file of ['./styles.css', './theme.css']) {
      const text = readFileSync(new URL(file, import.meta.url), 'utf8');
      const colours = [...text.matchAll(/^\s*--(canvas|surface-[123]|accent|border|text-[123]|evidence|ring|background|foreground|primary)\s*:/gm)].map(match => match[1]);
      expect(colours, file).toEqual([]);
    }
  });
});
