# afk hub — developer guide

The technical details behind the hub: install internals, the CLI, the HTTP API, how the relay works, and development. For the overview, see the [README](../README.md).

Two-way sync between [Zed](https://zed.dev) agent threads and a local hub, for **any ACP agent**
Zed can run (Claude Agent, Codex, Cursor, OpenCode, Pi, …). Start a thread in Zed and the hub
sees it immediately; start threads, send prompts, change model/mode/effort, and answer
permission requests from the hub — Zed shows everything live. Built to back a mobile app.

```
Zed ──ACP──▶ afk proxy ──ACP──▶ real agent      (one proxy per agent process)
                 │  mirror + commands (unix socket)
                 ▼
            afk hub ── SQLite history ── HTTP + SSE on 127.0.0.1:47321
```

## Install

Requires macOS and Zed with at least one agent (Claude Agent, Codex, …) added in its Agent panel.

```sh
curl -fsSL https://goafk.dev/install.sh | sh        # or, from a checkout: AFK_SOURCE=. sh install.sh
```

The installer uses your Node ≥ 22.18 or downloads a private copy into `~/.afk/runtime`
(checksum-verified), installs afk into `~/.afk/src`, adds `afk` to `~/.local/bin`,
and runs **`afk setup`**, which:

- syncs Zed's agents and starts the hub in the background (launchd);
- makes the Mac reachable from your phone: **Tailscale** (HTTPS on `:8443`, works anywhere) if it's
  installed and signed in, plus your **Wi-Fi** address (`--no-lan` / `--no-tailscale` to skip either);
- checks Zed, the hub and the network, and tells you if Zed needs one restart;
- prints a **pairing QR**. Scan it with the phone (camera or afk → *Add a Mac*): the app
  trades the one-time code for its own key. The hub's master token never leaves the Mac.

```sh
afk pair                 # new pairing QR (one phone, valid 15 minutes)
afk devices              # paired phones and when they were last seen
afk devices revoke <id>  # cut one phone off
afk permissions          # one-time macOS permission so the hub can start threads in Zed
```

Several Macs (say personal and work): run the installer on each and pair the phone with both.
The app's switcher (top of the sidebar) shows one Mac at a time and flags threads that need you
on the other; notifications come from every Mac and say which one when there are several.

`setup` adds a **“<Agent> (synced)”** entry for each agent to Zed's `settings.json` and a
new-thread keybinding (`ctrl-alt-cmd-z a`, `… b`, …) to `keymap.json`, both between
`// afk:begin` / `// afk:end` markers. Your registry defaults
(`default_config_options`: model, mode, effort, …) are applied to every synced thread.
Backups of both files go to `~/.afk/backups/`. Re-run `setup` after installing a new agent.

**Every thread of a registry Node agent (Claude Agent, Codex) is synced** — setup adds a small
preload (`~/.afk/preload.mjs`) to those agents' `env` in Zed's settings, so Zed keeps its own
agent name, icon and defaults. The preload strips itself from the environment, so programs the
agent runs (tests, npm, …) never load it. Agents that ship as native binaries (e.g. Cursor) and
custom agents get a “<Agent> (synced)” entry instead — pick that one in Zed's new-thread menu.

Threads that aren't open in Zed can be continued from the app (“Continue here”): the hub loads
the thread into a running agent process; Zed shows the new turns next time you open it.

## CLI

```sh
afk threads                          # list synced threads (status, project, title)
afk show <id>                        # transcript, settings, pending permissions
afk new my-app claude "fix the login bug"   # starts the thread in Zed
afk send <id> "also add a test"      # appears in Zed as your message
afk set <id> model sonnet            # Zed's dropdown updates
afk approve <id> allow-once          # answer a permission request
afk cancel <id>
afk watch [id]                       # live events incl. 🔔 needs input
afk status | uninstall | hub
```

Thread ids accept any unique prefix. Projects resolve from a path, `~/Herd/<name>`,
`~/projects/<name>`, or a known thread's folder name.

## Mobile app

The phone app lives in its own repo: [goafk/app](https://github.com/goafk/app) (Expo, Android today,
iPhone coming). It talks to this hub; pair it with `afk pair` (see Install).

## HTTP API

Loopback requests need no auth (unless relayed by a local proxy such as `tailscale serve`); anything else needs `Authorization: Bearer <token>` (or
`?token=` for SSE) — the token is in `~/.afk/config.json`. Set `"host": "0.0.0.0"` there
to expose the hub to your LAN, or (better) `tailscale serve --bg --https=8443 http://127.0.0.1:47321`
for HTTPS anywhere on your tailnet.

| Method | Path | Body |
|---|---|---|
| GET | `/health`, `/agents` | |
| GET | `/threads?status=&cwd=&agent=` | |
| GET | `/threads/:id` | → thread + `entries` + `pendingPermissions` |
| GET | `/events?thread=` | SSE: `thread.created`, `thread.updated`, `entry.upserted`, `entries.cleared`, `needs_input`, `agent.connected`, `agent.disconnected` |
| POST | `/threads` | `{cwd, agentId, prompt?}` → 201 (starts the thread in Zed) |
| POST | `/threads/:id/prompt` | `{text}` → 202 · 409 `busy` while a turn runs · 409 `offline` |
| POST | `/threads/:id/config` | `{configId, value}` |
| POST | `/threads/:id/permission` | `{optionId, requestId?}` |
| POST | `/threads/:id/cancel` | |
| GET | `/zed/sidebar` | Zed's own sidebar: project groups (front window order) with **all** threads, any agent, plus live status for synced ones |
| GET | `/zed/threads/:id` | any thread: live entries if synced, else rebuilt from Claude/Codex session logs |
| POST | `/zed/threads/:id/resume` | load a thread into a running agent so it can be continued without Zed |
| POST | `/zed/threads/:id/meta` | `{title?, archived?, autoApprove?}` — app-side rename / archive / approve-everything |
| POST | `/threads/:id/seen` | clear the thread's unread mark (inbox) |
| POST | `/threads/:id/elicitation` | `{requestId?, action, content}` — answer an agent question |
| GET | `/files?cwd=&q=` | fuzzy file search for @-mentions (known projects only) |
| GET | `/git/status?cwd=` · `/git/diff?cwd=&file=` | review changes |
| POST | `/git/commit` `{cwd, message, files?}` · `/git/discard` `{cwd, files}` · `/git/push` `{cwd}` | ship or drop them |
| POST | `/devices` | register an Expo push token `{token, platform, prefs}` |

`POST /threads/:id/prompt` also takes `mentions` (project-relative paths → ACP `resource_link`)
and `images` (`[{mimeType, data}]` base64 → ACP `image` blocks).

The hub polls Zed's database every 2s and emits `sidebar.changed` on the event stream.

`needs_input` fires with `reason: "turn_ended"` (with `stopReason`, or `error`) or
`reason: "permission"` (with `toolCall` and `options`).

## How it works / limits

- The proxy relays ACP byte-for-byte and only adds messages: injected prompts are echoed to
  Zed as a user message; injected request ids are `sync-<n>` and their replies never reach Zed;
  agent errors on injected prompts are shown in the thread as `⚠️ afk: …`.
- If the hub is down, Zed and the agent keep working; mirrored traffic is buffered (5,000 msgs)
  and flushed when the hub returns.
- When a thread's agent process exits (thread closed, Zed quit) the thread is `offline`:
  history stays readable; reopen it in Zed to make it live again (the transcript is rebuilt).
- Starting a thread presses the agent's keybinding through the small `AcpSyncKeys` helper app
  (so macOS's Accessibility grant covers only that helper, not `node`). Zed comes to the front
  for about a second.
- When the hub answers a permission, Zed is sent `$/cancel_request` for its prompt; if your
  Zed version ignores it, the stale card in Zed is harmless (its answer is dropped).
- Not synced: threads of non-synced agents, attachments in injected prompts.

## Development

```sh
npm test        # node:test, fake ACP agent + real proxy subprocesses
```

Design: `docs/superpowers/specs/2026-10-04-afk-design.md` ·
Plan: `docs/superpowers/plans/2026-10-04-afk.md`
