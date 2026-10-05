import type { Readable } from "node:stream";

/** Calls onLine for each newline-terminated line (without the newline). */
export function onLines(stream: Readable, onLine: (line: string) => void): void {
  let buf = "";
  stream.setEncoding("utf8");
  stream.on("data", (d: string) => {
    buf += d;
    let i: number;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      if (line.trim()) onLine(line);
    }
  });
}

export function tryParse(line: string): any | undefined {
  try {
    const v = JSON.parse(line);
    return v && typeof v === "object" ? v : undefined;
  } catch {
    return undefined;
  }
}
