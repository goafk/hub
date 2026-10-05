// Send "Share to AFK" launches to the share screen.
import { shareModule } from "../lib/share";

export function redirectSystemPath({ path }: { path: string; initial: boolean }) {
  try {
    const mod = shareModule();
    if (mod && path.includes(`dataUrl=${mod.getShareExtensionKey()}`)) return "/share";
    return path;
  } catch {
    return "/";
  }
}
