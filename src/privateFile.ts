// Files under ~/.afk hold keys, prompts and history: readable by this user only.
import fs from "node:fs";
import path from "node:path";

export function writePrivate(file: string, data: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, data, { mode: 0o600 });
  fs.chmodSync(file, 0o600); // mode only applies when the file is created
}

/** Tightens ~/.afk and what's already in it (older installs created them world-readable). */
export function lockDown(dir: string): void {
  try {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    fs.chmodSync(dir, 0o700);
    for (const name of fs.readdirSync(dir)) {
      const p = path.join(dir, name);
      const st = fs.lstatSync(p);
      if (st.isSymbolicLink()) continue;
      if (st.isDirectory()) {
        if (name === "logs" || name === "backups") lockDown(p);
      } else if (st.isFile() && !name.endsWith(".mjs") && !name.endsWith(".applescript")) fs.chmodSync(p, 0o600);
    }
  } catch {}
}
