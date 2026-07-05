# How to Use Claudegram

A hands-on manual for driving a real Claude Code agent on your machine from Telegram — and switching seamlessly between your phone and your terminal.

> New here? Install and configure first with the [README](README.md#quick-start). This guide assumes the bot is already running and you can message it.

---

## 1. First run

1. Start the bot: `npm run dev` (or `./scripts/claudegram-botctl.sh dev start`).
2. Open your bot in Telegram and send `/start`.
3. Point it at a project:
   - Send `/project` → tap through the inline **folder browser** → **✅ Use this folder**, or
   - Send `/project <path>` directly, e.g. `/project ~/code/myapp`.
   *(Paths must live inside `WORKSPACE_DIR`, which defaults to your home directory.)*
4. Just type. Everything that isn't a `/command` is sent to Claude.

```
You:  /project ~/code/myapp
Bot:  ✅ Project: myapp — you can now chat with Claude about this project!
You:  what does src/index.ts do?
Bot:  (Claude reads the file and answers, streaming as it goes)
```

If the folder already has past sessions, the bot offers **▶️ Resume latest / 🆕 Start new** — see §4.

---

## 2. Talking to Claude — the basics

- **Ask anything / give a task** — plain text. Claude has Bash, Read, Write, Edit, Glob, Grep, and Task tools, scoped to the current project.
- **Send a photo or image file** — it's saved under `<project>/.claudegram/uploads/` and Claude is told the path + your caption.
- **Send a voice note** — transcribed (Groq Whisper) and fed to Claude automatically.
- **`/status`** — current project, session id, model, mode, and context/cost usage.
- **`/context`** — detailed token/context breakdown.
- **`/clear`** — wipe the conversation and start fresh (asks for confirmation).

---

## 3. Projects & working directory

| Goal | Do this |
|------|---------|
| Open an existing project | `/project` (browser) or `/project <path>` |
| Create a new project | `/newproject <name>` (created under `WORKSPACE_DIR`) |
| See where you are | `/status` |
| Switch project | `/project <other>` — starts a fresh session in that folder |

Switching the working directory always starts a clean session for that folder (Claude sessions are bound to their directory). If the new folder has history, you'll be offered a resume (next section).

---

## 4. Switch between Telegram and your terminal

This is the headline feature. Because the bot runs Claude through the Agent SDK, **every Telegram conversation is a normal Claude session on disk** (`~/.claude/projects/…`) — the same thing `claude --resume` uses. So one conversation can move between phone and terminal.

### The golden rule
Use **one side at a time**, and reconcile when you switch. Don't type in both simultaneously (that branches the conversation).

### Terminal → Telegram (continue a CLI session on your phone)
You were working in a terminal (`claude` in `~/code/myapp`) and want to continue from your phone:

1. In Telegram: `/project ~/code/myapp`
2. The bot detects the on-disk session(s) and shows **▶️ Resume latest (2m ago)** — tap it.
   *(Or use `/resume` to pick from a list — `🖥️` = terminal, `💬` = Telegram.)*
3. Keep chatting. Claude has the full terminal context.

### Telegram → Terminal (continue a phone session in your terminal)
1. In Telegram: `/teleport`
2. Copy the command it gives you and run it, e.g.:
   ```
   cd "/home/you/code/myapp" && claude --resume 92e0a104-…
   ```
3. The terminal continues the **same** thread.

### Keeping a *running* terminal in sync — `/sync`
A live `claude` prompt never reloads its transcript, so if you send messages from Telegram while a terminal session is open, the terminal won't see them until you tell it to. That's what `/sync` is for:

- **In the terminal:** type `/sync` → it pulls in everything you did on Telegram since the last sync.
- **In Telegram:** `/sync` re-attaches the bot to the project's newest session (whether the terminal continued or forked) and tells you if a terminal recently used it.

> `/sync` injects the missing turns as context; it doesn't merge the underlying history tree. Still: one side at a time.

#### Install the terminal `/sync` command (one-time)
It ships in this repo at `.claude/commands/sync.md` and works automatically when your terminal is **inside this project**. To use `/sync` in **any** project, install it globally (replace the path with your checkout):

```bash
mkdir -p ~/.claude/commands
cat > ~/.claude/commands/sync.md <<'EOF'
---
description: Pull in Telegram turns for this session
allowed-tools: Bash
---
Silently incorporate the exchanges below (they happened via Telegram on this same session). Do not reply unless I ask.

!`node "/absolute/path/to/claudegram/scripts/claudegram-sync.mjs" pull --session ${CLAUDE_SESSION_ID}`
EOF
```

Requires Claude Code **v2.1.196+**. After installing, just type `/sync` at any `claude` prompt.

### Managing sessions
- `/sessions` — active + recent + on-disk sessions for the current project.
- `/resume` — pick a session to jump onto (bot- or terminal-started). Or `/resume <sessionId>` to import a specific id (e.g. pasted from Claude Desktop/CLI, or from another project directory).
- `/continue` — resume your most recent session (handy after a bot restart).

---

## 5. Run multiple projects at once

Each **chat or forum topic** is a fully independent lane — its own project, session, model, and `/sync`. They run **concurrently**.

Recommended setup: a Telegram **group with Topics enabled**, one topic per project.

```
Topic "myapp"    → /project ~/code/myapp   → chat about myapp
Topic "website"  → /project ~/code/website → chat about website
Topic "scripts"  → /project ~/tools        → chat about tools
```

Send messages in different topics at the same time — they don't block or bleed into each other. Keep it **one project per topic**; `/sync` won't hijack a session another topic is driving.

---

## 6. Agent modes

| Command | What it does |
|---------|--------------|
| `/plan <task>` | Plan mode — Claude designs an approach before touching code |
| `/explore <question>` | Read-only exploration of the codebase to answer a question |
| `/loop <task>` | Works iteratively until the task is done (bounded by `MAX_LOOP_ITERATIONS`) |

```
You:  /plan add JWT auth to the API
Bot:  (Claude produces a step-by-step plan without editing files)
```

---

## 7. Output & model settings

| Command | Effect |
|---------|--------|
| `/model` | Show/switch model — **Opus** · **Sonnet** · **Haiku** |
| `/mode` | Toggle **streaming** (live-updating) vs **wait** (single reply) |
| `/terminalui` | Toggle terminal-style display with tool spinners |
| `/telegraph` | Toggle Telegraph Instant View for long responses/tables |
| `/tts` | Toggle spoken voice replies and pick a voice |

These are per-chat/topic, so each project can have its own model and display style.

---

## 8. Media, files & voice

| Command | Use |
|---------|-----|
| `/file <path>` | Download a file from the current project to Telegram |
| `/reddit <target>` | Fetch Reddit posts, subreddits, or user profiles |
| `/vreddit <url>` | Download a Reddit-hosted video (auto-compresses if large) |
| `/medium <url>` | Fetch a Medium article via Freedium |
| `/extract <url>` | Pull text/audio/video from YouTube, TikTok, Instagram |
| `/transcribe` | Transcribe an audio file or voice note to text |
| *send a voice note* | Auto-transcribed and sent to Claude |
| *send a photo* | Saved to the project and shown to Claude |

Some of these are gated by `.env` flags/keys — see the [README integrations](README.md#optional-integrations).

---

## 9. Controlling a running task

| Command | Effect |
|---------|--------|
| `/cancel` | Stop the current request (keeps the session) |
| `/softreset` | Cancel + clear the session, then offer Continue/Resume |
| `/restartbot` | Restart the bot process |
| `/botstatus` | Show bot process status |
| `/ping` | Quick "are you alive?" check |

`/cancel`, `/softreset`, and `/ping` work even while a request is running (they bypass the per-chat queue).

---

## 10. Command cheat sheet

```
Getting started   /start  /project  /newproject  /status  /clear  /commands
Sessions          /sessions  /resume  /continue  /sync  /teleport
Agent modes       /plan  /explore  /loop
Settings          /model  /mode  /terminalui  /telegraph  /tts
Content           /file  /reddit  /vreddit  /medium  /extract  /transcribe
Control           /cancel  /softreset  /context  /botstatus  /restartbot  /ping
```

Run `/commands` in the bot for the live, config-aware list.

---

## 11. Tips & troubleshooting

- **"No project set."** Send `/project <path>` first (or `/continue` to restore your last session after a restart).
- **Bot seems out of date vs. terminal.** Send any message — the bot re-reads the transcript each turn — or run `/sync`.
- **Terminal seems out of date vs. phone.** Run `/sync` in the terminal (requires the command installed, §4).
- **`/teleport` says "no session yet."** Send at least one message first so a session id exists.
- **"Prompt is too long" / context limit when resuming a big session.** The bot uses the model from your `~/.claude/settings.json` by default (same as your terminal), so large 1M-context sessions fit. If you pinned a model with `/model`, that overrides it — for big sessions pick a 1M model, or set `CLAUDE_MODEL=opus[1m]` in `.env`. Either way the bot now recovers gracefully (starts a fresh session) instead of getting stuck.
- **Path rejected on `/project`.** It must be inside `WORKSPACE_DIR` (default `$HOME`). Set `WORKSPACE_DIR` in `.env` to widen it.
- **Editing Claudegram's own code?** Run in **prod mode** to avoid hot-reload restarts, then `/restartbot` and `/continue`. See [README → Self-Editing Workflow](README.md#self-editing-workflow).
- **Don't drive both sides at the same instant.** Use one at a time and `/sync` when you switch.
