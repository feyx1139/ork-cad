// Colours for parts, on screen and in STEP files: printed parts orange, paper and card tan, the
// rest grey. No CAD code in here, so the page can use it too.

/** The material looks 3D printed (PLA, PETG...). */
export const PRINTED = /PLA|PETG|ABS|ASA|nylon|resin|print/i;

export function partColor(material: string): string {
  if (PRINTED.test(material)) return "#e8833a";
  if (/paper|card|kraft|glassine|fiber/i.test(material)) return "#c9a56c";
  return "#9aa4b1";
}
