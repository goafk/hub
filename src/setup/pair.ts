// Pairing link + QR for the phone app. The link carries how to reach this Mac and a one-time code;
// never the hub's master token.
import { createRequire } from "node:module";
import type { Config } from "../config.ts";
import { Pairing } from "../hub/pairing.ts";

const require = createRequire(import.meta.url);

export function pairingLink(cfg: Config, name: string, urls: string[], code: string): string {
  const q = new URLSearchParams({ h: cfg.hubId, n: name, c: code });
  for (const u of urls) q.append("u", u);
  return `zedthreads://pair?${q.toString()}`;
}

export function qr(text: string): Promise<string> {
  const qrcode = require("../vendor/qrcode-terminal/lib/main.js");
  return new Promise((resolve) => qrcode.generate(text, { small: true }, (s: string) => resolve(s)));
}

export async function printPairing(home: string, cfg: Config, name: string, urls: string[]): Promise<void> {
  const { code, expiresAt } = new Pairing(home).createCode();
  const link = pairingLink(cfg, name, urls, code);
  console.log("\nScan with your phone's camera (or in the afk app → Add a Mac):\n");
  console.log(await qr(link));
  const mins = Math.round((expiresAt - Date.now()) / 60_000);
  console.log(`Pairing code ${code.slice(0, 5)}-${code.slice(5)} · valid ${mins} min, one phone`);
  console.log(`Link: ${link}`);
  console.log(`\nMore phones later: afk pair · See or remove phones: afk devices`);
}
