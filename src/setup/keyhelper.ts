// A tiny AppleScript applet that presses Zed keybindings for the hub.
// macOS grants Accessibility per app, so the user approves this one helper
// instead of giving the `node` binary control of the whole computer.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

export const HELPER_BUNDLE_ID = "dev.acp-sync.keys";

/**
 * Runs a harmless System Events call through the helper in the foreground so macOS shows
 * its permission prompts. Returns "ok" or the error text.
 */
export function probeKeyHelper(home: string): string {
  const f = keyHelperFiles(home);
  // key code 63 is the fn key: requires Accessibility, has no visible effect.
  fs.writeFileSync(f.script, 'tell application "System Events" to key code 63');
  fs.rmSync(f.result, { force: true });
  execFileSync("open", ["-W", "-a", f.app]);
  return fs.existsSync(f.result) ? fs.readFileSync(f.result, "utf8").replace(/^error: /, "") : "helper produced no result";
}

export function keyHelperFiles(home: string) {
  return {
    app: path.join(home, "AcpSyncKeys.app"),
    script: path.join(home, "keys.applescript"),
    result: path.join(home, "keys.result"),
  };
}

/** Compiles the applet once. Never recompiles: that would invalidate the user's permission grant. */
export function ensureKeyHelper(home: string): string {
  const f = keyHelperFiles(home);
  if (fs.existsSync(f.app)) return f.app;
  fs.mkdirSync(home, { recursive: true });
  const src = [
    `set scriptFile to POSIX file ${JSON.stringify(f.script)}`,
    `set resultFile to ${JSON.stringify(f.result)}`,
    "try",
    "  run script (read scriptFile as «class utf8»)",
    '  do shell script "printf ok > " & quoted form of resultFile',
    "on error errMsg",
    '  do shell script "printf %s " & quoted form of ("error: " & errMsg) & " > " & quoted form of resultFile',
    "end try",
  ];
  execFileSync("osacompile", ["-o", f.app, ...src.flatMap((l) => ["-e", l])]);
  const plist = path.join(f.app, "Contents", "Info.plist");
  const set = (key: string, type: string, value: string) => {
    try {
      execFileSync("/usr/libexec/PlistBuddy", ["-c", `Delete :${key}`, plist], { stdio: "ignore" });
    } catch {}
    execFileSync("/usr/libexec/PlistBuddy", ["-c", `Add :${key} ${type} ${value}`, plist]);
  };
  // A stable identity so macOS privacy permissions stick, and no Dock icon on each launch.
  set("CFBundleIdentifier", "string", HELPER_BUNDLE_ID);
  set("CFBundleName", "string", "AcpSyncKeys");
  set("NSAppleEventsUsageDescription", "string", "acp-sync presses the Zed keybinding that starts a new agent thread.");
  set("LSUIElement", "bool", "true");
  // Editing Info.plist breaks osacompile's signature; macOS denies permissions to broken signatures.
  execFileSync("codesign", ["--force", "--deep", "--sign", "-", f.app], { stdio: "ignore" });
  return f.app;
}
