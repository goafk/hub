// Minimal JSONC support: comments and trailing commas, string-aware.

/** Yields each significant character (outside strings and comments) and each string's start. */
export function scanSignificant(text: string, visit: (ch: string, index: number, str?: string, end?: number) => void): void {
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (ch === '"') {
      const start = i;
      i++;
      while (i < text.length && text[i] !== '"') i += text[i] === "\\" ? 2 : 1;
      visit('"', start, JSON.parse(text.slice(start, i + 1)), i);
      i++;
    } else if (ch === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") i++;
    } else if (ch === "/" && text[i + 1] === "*") {
      const end = text.indexOf("*/", i + 2);
      i = end < 0 ? text.length : end + 2;
    } else {
      if (!/\s/.test(ch)) visit(ch, i);
      i++;
    }
  }
}

export function stripJsonc(text: string): string {
  // Rebuild from significant chars and strings (literals like `true` arrive char by char),
  // dropping commas that precede } or ].
  const parts: { s: string; ch: string }[] = [];
  scanSignificant(text, (ch, _index, str) => {
    parts.push({ s: ch === '"' ? JSON.stringify(str) : ch, ch });
  });
  let out = "";
  for (let k = 0; k < parts.length; k++) {
    const p = parts[k];
    if (p.ch === ",") {
      const next = parts[k + 1];
      if (!next || next.ch === "}" || next.ch === "]") continue;
    }
    out += p.s;
  }
  return out;
}

export function parseJsonc(text: string): any {
  return JSON.parse(stripJsonc(text));
}
