// App-side thread metadata kept by the hub: rename, archive, auto-approve. (Zed's own sidebar
// state lives in Zed's database, which Zed keeps in memory, so we don't write to it.)
import fs from "node:fs";
import path from "node:path";

export type ThreadMeta = { title?: string; archived?: boolean; autoApprove?: boolean; /** Started from the phone without Zed: not in Zed's sidebar. */ phoneOnly?: boolean };

export class MetaStore {
  private file: string;
  private data: Record<string, ThreadMeta>;

  constructor(file: string) {
    this.file = file;
    try {
      this.data = JSON.parse(fs.readFileSync(file, "utf8"));
    } catch {
      this.data = {};
    }
  }

  get(id: string): ThreadMeta {
    return this.data[id] ?? {};
  }

  set(id: string, patch: ThreadMeta): ThreadMeta {
    const next: ThreadMeta = { ...this.get(id) };
    if (patch.title !== undefined) next.title = patch.title.trim() || undefined;
    if (patch.archived !== undefined) next.archived = !!patch.archived || undefined;
    if (patch.autoApprove !== undefined) next.autoApprove = !!patch.autoApprove || undefined;
    if (patch.phoneOnly !== undefined) next.phoneOnly = !!patch.phoneOnly || undefined;
    if (Object.values(next).every((v) => v === undefined)) delete this.data[id];
    else this.data[id] = next;
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(this.file, JSON.stringify(this.data, null, 2));
    return next;
  }
}

/** The option to pick when a thread auto-approves: "always allow" > "allow once" > any allow. */
export function pickAllowOption(options: Array<{ optionId: string; kind?: string; name?: string }>): string | undefined {
  return (
    options.find((o) => o.kind === "allow_always")?.optionId ??
    options.find((o) => o.kind === "allow_once")?.optionId ??
    options.find((o) => /^allow/i.test(o.optionId) || /^allow/i.test(o.name ?? ""))?.optionId
  );
}
