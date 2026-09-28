// Tiny generated placeholders that stand in for evidence bytes in the harness.
// They are clearly labelled synthetic; no original media is bundled. Audio and
// video resolve to an empty data URL so the real viewer exercises its
// "cannot decode" degradation path instead of playing fabricated media.

function svg(label: string, detail: string, width: number, height: number): string {
  const body = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">`
    + `<rect width="100%" height="100%" fill="#8a8f98"/>`
    + `<rect x="12" y="12" width="${width - 24}" height="${height - 24}" fill="none" stroke="#5d626b" stroke-width="2" stroke-dasharray="10 8"/>`
    + `<text x="50%" y="46%" text-anchor="middle" font-family="sans-serif" font-size="${Math.round(width / 22)}" fill="#1d2026">SYNTHETIC PLACEHOLDER</text>`
    + `<text x="50%" y="56%" text-anchor="middle" font-family="sans-serif" font-size="${Math.round(width / 34)}" fill="#1d2026">${escapeXml(label)}</text>`
    + `<text x="50%" y="64%" text-anchor="middle" font-family="sans-serif" font-size="${Math.round(width / 40)}" fill="#1d2026">${escapeXml(detail)}</text>`
    + '</svg>';
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(body)}`;
}

function escapeXml(value: string) { return value.replace(/[<>&"']/g, character => `&#${character.charCodeAt(0)};`); }

/** Resolve an `evidence://` path (source id or artifact/<id>) to placeholder bytes. */
export function placeholderUrl(path: string, kindOf: (sourceId: string) => string | null): string {
  const decoded = decodeURIComponent(path);
  if (decoded.startsWith('artifact/')) {
    const artifact = decoded.slice('artifact/'.length);
    const page = /^page-(?:redacted-)?.+-(\d+)$/.exec(artifact);
    if (page) return svg(artifact.startsWith('page-redacted') ? 'Flattened redaction review page' : 'Rendered PDF page', `page ${page[1]} · not a real document`, 612, 792);
    const frame = /^frame-.+-(\d+)$/.exec(artifact);
    if (frame) return svg('Sampled video frame', `${frame[1]} s · no real footage`, 320, 180);
    if (artifact.startsWith('image-')) return svg('Derived image', 'no real photograph', 800, 600);
    return 'data:,';
  }
  const kind = kindOf(decoded);
  if (kind === 'image') return svg('Evidence photograph', 'no real photograph is bundled', 1200, 800);
  return 'data:,';
}
