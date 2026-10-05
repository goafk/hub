# AFK (mobile app)

Expo app that mirrors Zed's agent **Threads sidebar** and **thread view** from the afk hub on
your Mac: the same projects in the same order, every thread with its agent icon and age, full
transcripts (markdown, tables, tool calls, thinking), and the live composer with Zed's mode /
model / effort dropdowns and Fast mode toggle, permission prompts, stop, and new threads.

Phone: sidebar → tap a thread. Tablet / landscape / web: sidebar + thread side by side like Zed.
Themes follow the system: Catppuccin Latte (light) and One Dark (dark), Fira Code for input.

## Features

- Zed's sidebar and agent panel, Zed themes; full transcripts (markdown, tables, code with syntax
  colors, diffs, mermaid, footnotes), tool calls with diffs/output, plans, thinking
- **Every** Claude Agent / Codex thread is live; “Continue here” for threads not open in Zed
- Composer: model / mode / effort / Fast mode, `/` commands (fuzzy), `@` files and folders,
  photos & screenshots, quick replies, stop, context + cost meter
- Agent questions (Zed's “Input Requested” card) and permission prompts; “approve everything” per thread
- **Needs you** inbox with badge and unread dots; push notifications (installed app) — tap opens the thread
- **Review changes** per project: diffs, commit (& push), push, discard picked files
- Rename / archive (long-press or swipe), find in thread, history view
- Android: share text / links / screenshots into a new or existing thread; home-screen widget
- Fingerprint / Face ID lock; HTTPS over Tailscale

## Install the app (Android)

Install the APK from the latest EAS build (`npx eas-cli build:list`). On first launch it asks you
to pair: run `afk setup` (or `afk pair`) on the Mac and scan the QR. Pair more Macs from the
switcher at the top of the sidebar (*Add a Mac*). App updates without reinstalling:
`npx eas-cli update --channel preview --environment preview -m "…"` (the app shows
"Update ready · Restart").

## Run it in Expo Go / the browser (development)

1. `cd app && npx expo start` (keep it running); `--web` for the browser, which talks to the hub
   on this computer without pairing.
2. In Expo Go, open *Add a Mac* → *Paste pairing link* with the link `afk pair` prints.
   Scanning, share-to-thread, the widget and push need the installed app.

You can also type an address and key by hand: gear icon in the sidebar.

## What's live and what's read-only

| Thread uses… | In the app |
|---|---|
| a “(synced)” agent, open in Zed | live: streaming, send, settings, permissions, stop |
| a “(synced)” agent, not running | transcript; “open it in Zed to continue” |
| a regular agent (Claude Agent, Codex, …) | transcript from the agent's own logs (Claude, Codex); read-only |

## Develop

```sh
npx expo start --web     # browser at http://localhost:8081 (connects to http://localhost:47321)
npx tsc --noEmit
npx expo export --platform ios --platform android   # native bundle check
```

Code: `src/app` routes (`index` sidebar/split, `thread/[id]`, `connect` pairing link),
`src/components` (Sidebar, ThreadView, Entries, Markdown, Composer, Dialogs, Sheet, Icons),
`src/lib` (api, sse, store, theme, time).
