// Review what agents changed in a project: git status, per-file diffs, commit, discard, push.
import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

export type FileChange = { path: string; status: "modified" | "added" | "deleted" | "renamed" | "untracked"; added: number; removed: number; staged: boolean };
export type GitStatus = { branch: string; ahead: number; behind: number; upstream: boolean; files: FileChange[] };

function git(cwd: string, args: string[], timeout = 20000): Promise<string> {
  return new Promise((resolve, reject) =>
    execFile("git", args, { cwd, timeout, maxBuffer: 32 * 1024 * 1024 }, (err, stdout, stderr) =>
      err ? reject(Object.assign(new Error((stderr || err.message).trim()), { code: "git_error" })) : resolve(stdout),
    ),
  );
}

export async function status(cwd: string): Promise<GitStatus> {
  const branch = (await git(cwd, ["rev-parse", "--abbrev-ref", "HEAD"]).catch(() => "HEAD")).trim();
  let ahead = 0;
  let behind = 0;
  let upstream = true;
  try {
    const [b, a] = (await git(cwd, ["rev-list", "--left-right", "--count", "@{u}...HEAD"])).trim().split(/\s+/).map(Number);
    behind = b;
    ahead = a;
  } catch {
    upstream = false;
  }
  const porcelain = await git(cwd, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]);
  const numstat = await git(cwd, ["diff", "HEAD", "--numstat", "-z"]).catch(() => "");
  const counts = new Map<string, { added: number; removed: number }>();
  // -z numstat: "added\tremoved\tpath\0" (renames: "a\tr\t\0old\0new\0")
  const parts = numstat.split("\0");
  for (let i = 0; i < parts.length; i++) {
    const m = /^(\d+|-)\t(\d+|-)\t(.*)$/.exec(parts[i]);
    if (!m) continue;
    let file = m[3];
    if (!file) {
      file = parts[i + 2];
      i += 2;
    }
    counts.set(file, { added: m[1] === "-" ? 0 : Number(m[1]), removed: m[2] === "-" ? 0 : Number(m[2]) });
  }
  const files: FileChange[] = [];
  const entries = porcelain.split("\0").filter(Boolean);
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    const x = e[0];
    const y = e[1];
    let file = e.slice(3);
    if (x === "R" || x === "C") i++; // next entry is the original path
    const st: FileChange["status"] =
      x === "?" ? "untracked" : x === "A" ? "added" : x === "D" || y === "D" ? "deleted" : x === "R" ? "renamed" : "modified";
    let c = counts.get(file) ?? { added: 0, removed: 0 };
    if (st === "untracked") c = { added: countLines(path.join(cwd, file)), removed: 0 };
    files.push({ path: file, status: st, ...c, staged: x !== " " && x !== "?" });
  }
  files.sort((a, b) => a.path.localeCompare(b.path));
  return { branch, ahead, behind, upstream, files };
}

function countLines(file: string): number {
  try {
    const st = fs.statSync(file);
    if (!st.isFile() || st.size > 2_000_000) return 0;
    const text = fs.readFileSync(file, "utf8");
    return text ? text.split("\n").length - (text.endsWith("\n") ? 1 : 0) : 0;
  } catch {
    return 0;
  }
}

/** Unified diff of one file against HEAD (new files diffed against nothing). */
export async function diff(cwd: string, file: string): Promise<string> {
  safePath(cwd, file);
  const tracked = await git(cwd, ["ls-files", "--error-unmatch", "--", file]).then(() => true, () => false);
  if (tracked) return git(cwd, ["diff", "HEAD", "--no-color", "--", file]);
  // Untracked: show as an all-new file.
  const abs = path.join(cwd, file);
  const st = fs.statSync(abs);
  if (st.size > 2_000_000) return `--- /dev/null\n+++ b/${file}\n(new file, ${st.size} bytes — too large to show)\n`;
  const text = fs.readFileSync(abs, "utf8");
  if (text.includes("\0")) return `--- /dev/null\n+++ b/${file}\n(new binary file)\n`;
  const lines = text.endsWith("\n") ? text.slice(0, -1).split("\n") : text.split("\n");
  return `--- /dev/null\n+++ b/${file}\n@@ -0,0 +1,${lines.length} @@\n${lines.map((l) => "+" + l).join("\n")}\n`;
}

export async function commit(cwd: string, message: string, files?: string[]): Promise<{ hash: string }> {
  if (!message.trim()) throw Object.assign(new Error("commit message is required"), { code: "invalid" });
  if (files?.length) {
    files.forEach((f) => safePath(cwd, f));
    await git(cwd, ["add", "--all", "--", ...files]);
  } else await git(cwd, ["add", "--all"]);
  await git(cwd, ["commit", "-m", message]);
  return { hash: (await git(cwd, ["rev-parse", "--short", "HEAD"])).trim() };
}

/** Throws away changes to files: tracked files go back to HEAD, untracked files are deleted. */
export async function discard(cwd: string, files: string[]): Promise<void> {
  if (!files.length) throw Object.assign(new Error("no files given"), { code: "invalid" });
  const st = await status(cwd);
  for (const f of files) {
    safePath(cwd, f);
    const c = st.files.find((x) => x.path === f);
    if (!c) continue;
    if (c.status === "untracked") fs.rmSync(path.join(cwd, f), { force: true });
    else if (c.status === "added") await git(cwd, ["rm", "-f", "--", f]);
    else await git(cwd, ["restore", "--staged", "--worktree", "--source=HEAD", "--", f]);
  }
}

export async function push(cwd: string): Promise<string> {
  const st = await status(cwd);
  const out = st.upstream ? await git(cwd, ["push"], 60000) : await git(cwd, ["push", "-u", "origin", "HEAD"], 60000);
  return out.trim() || "pushed";
}

function safePath(cwd: string, rel: string): string {
  const abs = path.resolve(cwd, rel);
  if (!abs.startsWith(path.resolve(cwd) + path.sep)) throw Object.assign(new Error(`path outside project: ${rel}`), { code: "invalid" });
  return abs;
}
