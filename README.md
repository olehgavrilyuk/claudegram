<div align="center">

# Claudegram

**Your personal AI agent, running on your machine, controlled from Telegram.**

[![TypeScript](https://img.shields.io/badge/TypeScript-5.x-3178c6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![Claude](https://img.shields.io/badge/Claude_Agent_SDK-Anthropic-cc785c?logo=anthropic&logoColor=white)](https://docs.anthropic.com/en/docs/claude-code)
[![Telegram](https://img.shields.io/badge/Telegram_Bot-Grammy-26a5e4?logo=telegram&logoColor=white)](https://grammy.dev/)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)

<br />

```
  Telegram  ──▶  Grammy Bot  ──▶  Claude Agent SDK  ──▶  Your Machine
  voice/text     command router     agentic runtime       bash, files, code
```

</div>

---

## What is this?

Claudegram bridges Telegram to a **full Claude Code agent** running locally on your machine. Send a message in Telegram — Claude reads your files, runs commands, writes code, browses Reddit, fetches Medium articles, transcribes voice notes, and speaks responses back. All from your phone.

This is not a simple API wrapper. It's the real Claude Code agent with tool access — Bash, file I/O, code editing, web browsing — packaged behind a Telegram interface with streaming responses, session memory, and rich output formatting.

---

## Features

<table>
<tr>
<td width="50%" valign="top">

### Agent Core
- Full Claude Code with tool access (Bash, Read, Write, Edit, Glob, Grep)
- Session resume across messages — Claude remembers everything
- Native `~/.claude` sessions — bot and terminal share one continuous thread; switch back and forth seamlessly
- `/sync` on both sides — pull the other side's latest turns on demand (Telegram ⇄ terminal)
- Project-based working directories
- Streaming responses with live-updating messages
- Model picker: Sonnet · Opus · Haiku, plus 1M-context `opus[1m]` / `sonnet[1m]` — or inherit your terminal's `settings.json` model so resumed sessions don't overflow
- Plan mode, explore mode, loop mode

### Reddit Integration
- `/reddit` — posts, subreddits, user profiles
- `/vreddit` — download & send Reddit-hosted videos
- Auto-compression for videos > 50 MB (CRF → two-pass)
- Original oversized videos archived locally
- Large threads auto-export to JSON

### Media Extraction
- `/extract` — YouTube, Instagram, TikTok video/audio/transcript
- Text, audio (MP3), video (MP4), or all modes
- Requires yt-dlp, ffmpeg (system binaries)

### Medium Integration
- `/medium` — fetch paywalled articles via Freedium
- Telegraph Instant View, save as Markdown, or both
- Pure TypeScript, no Python/Playwright needed

</td>
<td width="50%" valign="top">

### Voice & Audio
- Send a voice note → transcribed via Groq Whisper → fed to Claude
- `/transcribe` — standalone transcription (reply-to or prompt)
- `/tts` — agent responses spoken back as Telegram voice notes
- 13 voices via OpenAI TTS (`gpt-4o-mini-tts`)

### Rich Output
- MarkdownV2 formatting with automatic escaping
- Telegraph Instant View for long responses & tables
- Smart chunking that preserves code blocks
- ForceReply interactive prompts for multi-step commands
- `/teleport` — continue your session in the terminal (same thread); `/resume` — pull a terminal session into Telegram
- Inline keyboards for settings (model, mode, TTS, clear)

### Terminal UI
- Terminal-style display with tool status spinners
- Shows what Claude is doing in real time
- Toggle with `/terminalui`

### MCP Tools (Intelligent Routing)
- Talk naturally — Claude auto-uses the right tools
- Reddit, Medium, YouTube, project management via MCP
- No explicit commands needed for common tasks

### Forum Topic Sessions
- Each chat/forum topic runs as an independent session
- Work on multiple projects in parallel — processed concurrently
- Each topic keeps its own project, session, and terminal `/sync`

### Image Uploads
- Send photos or image docs in chat
- Saved to project under `.claudegram/uploads/`
- Claude is notified with path + caption

### Provider Switching (optional)
- `/provider` switches a chat between Claude and OpenCode
- OpenCode fronts 75+ LLM providers
- Enable with `OPENCODE_ENABLED`

</td>
</tr>
</table>

---

## Sessions: Bot ⇄ Terminal

Claudegram drives Claude through the Agent SDK, so **every Telegram conversation is a native Claude session** on disk (`~/.claude/projects/…`) — the same format the `claude` CLI uses. You can move between your phone and your terminal on **one continuous thread**.

**Telegram already sees the terminal.** The bot re-reads the session transcript on every message, so anything you just did in a terminal `claude` session is automatically in context on the next Telegram message.

**Bringing sessions together (either direction):**
- `/resume` and `/sessions` list sessions for the current project from **both** the bot and the terminal (`💬` Telegram · `🖥️` terminal), so you can jump onto a terminal-started session.
- `/project`-ing into a folder that already has sessions offers a one-tap **Resume latest / Start new**.
- `/teleport` gives you a `cd … && claude --resume <id>` to continue in a terminal — same thread, no fork.

**Keeping a *running* terminal in sync** needs one command, because a live `claude` REPL never reloads its own transcript:

- **In Telegram:** `/sync` re-attaches the bot to the project's newest session (whether the terminal continued or forked) and reports if a terminal recently used it.
- **In the terminal:** `/sync` pulls in the turns you sent via Telegram since you last synced.

### Installing the terminal `/sync` command

It ships in this repo at `.claude/commands/sync.md` (works when your terminal is in this project). To make `/sync` available in **any** project, install it globally — replace the path with your checkout:

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

Requires Claude Code v2.1.196+ (for the `${CLAUDE_SESSION_ID}` substitution).

> `/sync` is a **soft reconciliation** — it injects the missing turns as context; it does not merge the underlying transcript tree. Avoid driving both sides at the exact same time.

**Collision guard.** If the terminal is *mid-turn* on a session, the bot won't start a colliding turn from Telegram — it replies "the terminal is working…" and **pings you when it frees up**. Send `/stopwait` to cancel that ping.

### Running multiple projects at once

Every Telegram **chat or forum topic is an independent lane** — its own project, its own Claude session, and its own `/sync` with its own terminal. Open a forum topic per project and drive them **simultaneously**: the bot processes each concurrently and keeps their sessions fully isolated (state is keyed per chat/topic, and each sidecar per native session id). The model is **one project per chat/topic** — `/sync` will not hijack a session another chat is actively driving.

---

## Quick Start

### Prerequisites

| Requirement | Notes |
|-------------|-------|
| **Node.js 18+** | with npm |
| **Claude Code CLI** | installed and authenticated — `claude` in your PATH |
| **Telegram bot token** | from [@BotFather](https://t.me/botfather) |
| **Your Telegram user ID** | from [@userinfobot](https://t.me/userinfobot) |

### Setup

```bash
git clone https://github.com/olehgavrilyuk/claudegram.git
cd claudegram
cp .env.example .env
```

Edit `.env`:

```bash
TELEGRAM_BOT_TOKEN=your_bot_token
ALLOWED_USER_IDS=your_user_id
```

### Run

```bash
npm install
npm run dev        # dev mode with hot reload
```

Open your bot in Telegram → `/start`

---

## Commands

### Session
| Command | Description |
|---------|-------------|
| `/start` | Welcome message |
| `/project` | Set working directory (interactive picker) |
| `/newproject <name>` | Create and switch to a new project |
| `/clear` | Clear conversation + session |
| `/status` | Current session info |
| `/sessions` | List saved sessions (bot + terminal, for the current project) |
| `/resume` | Pick from recent sessions (bot + terminal); `/resume <id>` imports a session by id |
| `/continue` | Resume most recent session |
| `/sync` | Sync with the terminal — re-attach to the project's newest session |
| `/stopwait` | Stop waiting for a busy terminal (cancels the "I'll ping you" watch) |
| `/teleport` | Move session to terminal (same continuous thread) |

### Agent Modes
| Command | Description |
|---------|-------------|
| `/plan` | Plan mode for complex tasks |
| `/explore` | Explore codebase to answer questions |
| `/loop` | Run iteratively until task complete |
| `/model` | Switch model — Opus / Sonnet / Haiku, plus 1M-context `opus[1m]` / `sonnet[1m]` |
| `/mode` | Toggle streaming / wait |
| `/terminalui` | Toggle terminal-style display |
| `/provider` | Switch AI backend — Claude or OpenCode (only when `OPENCODE_ENABLED`) |

### Content
| Command | Description |
|---------|-------------|
| `/reddit` | Fetch Reddit posts, subreddits, profiles |
| `/vreddit` | Download Reddit-hosted videos |
| `/medium` | Fetch Medium articles via Freedium |
| `/file` | Download a project file |
| `/telegraph` | Toggle Instant View for long responses |
| `/extract <url>` | Download media from YouTube, TikTok, Instagram |

### Voice & TTS
| Command | Description |
|---------|-------------|
| `/tts` | Toggle voice replies, pick voice |
| `/transcribe` | Transcribe audio to text |
| *Send voice note* | Auto-transcribed → processed by Claude |

### Utility
| Command | Description |
|---------|-------------|
| `/ping` | Health check |
| `/context` | Show Claude context / token usage |
| `/botstatus` | Bot process status |
| `/restartbot` | Restart the bot |
| `/cancel` | Cancel current request |
| `/commands` | Show all commands |
| `/softreset` | Soft reset (cancel + clear session) |

---

## Optional Integrations

<details>
<summary><strong>Reddit — <code>/reddit</code> & <code>/vreddit</code></strong></summary>

`/reddit` is now a pure TypeScript module using Reddit's OAuth2 API directly — no external Python dependency.

```bash
# .env
REDDIT_CLIENT_ID=your_client_id
REDDIT_CLIENT_SECRET=your_client_secret
REDDIT_USERNAME=bot_account
REDDIT_PASSWORD=bot_password
```

Create a "script" app at https://www.reddit.com/prefs/apps/. Use a dedicated bot account — NOT your personal credentials. Video downloads need `ffmpeg` and `ffprobe` on your PATH.

</details>

<details>
<summary><strong>Medium — <code>/medium</code></strong></summary>

Pure TypeScript via Freedium mirror — no extra dependencies.

```bash
# .env (optional tuning)
FREEDIUM_HOST=freedium-mirror.cfd
MEDIUM_TIMEOUT_MS=15000
```

</details>

<details>
<summary><strong>Voice Transcription — Groq Whisper</strong></summary>

```bash
# .env
GROQ_API_KEY=your_groq_key
GROQ_TRANSCRIBE_PATH=/absolute/path/to/groq_transcribe.py
```

</details>

<details>
<summary><strong>Text-to-Speech — OpenAI TTS</strong></summary>

```bash
# .env
OPENAI_API_KEY=your_openai_key
TTS_MODEL=gpt-4o-mini-tts
TTS_VOICE=coral
TTS_RESPONSE_FORMAT=opus
```

13 voices available: `alloy`, `ash`, `ballad`, `cedar`, `coral`, `echo`, `fable`, `marin`, `nova`, `onyx`, `sage`, `shimmer`, `verse`

</details>

<details>
<summary><strong>OpenCode — <code>/provider</code></strong></summary>

Optional alternative backend. When enabled, `/provider` switches a chat between **Claude** (the default Agent SDK backend) and **OpenCode**, which fronts 75+ LLM providers. Switching a chat clears its model so you can pick one with `/model`.

```bash
# .env
OPENCODE_ENABLED=true
# Optional: connect to a running server instead of the embedded one
# OPENCODE_BASE_URL=http://localhost:4096
# OPENCODE_PORT=4096
```

Requires [OpenCode](https://opencode.ai) installed. Session commands like `/sync` and `/teleport` are Claude-only and are skipped on the OpenCode provider.

</details>

---

## Configuration Reference

All config lives in `.env`. See [`.env.example`](.env.example) for the full annotated reference.

### Required

| Variable | Description |
|----------|-------------|
| `TELEGRAM_BOT_TOKEN` | Bot token from @BotFather |
| `ALLOWED_USER_IDS` | Comma-separated Telegram user IDs |

### Core

| Variable | Default | Description |
|----------|---------|-------------|
| `ANTHROPIC_API_KEY` | — | API key (optional with Claude Max subscription) |
| `WORKSPACE_DIR` | `$HOME` | Root directory for project picker |
| `CLAUDE_EXECUTABLE_PATH` | `claude` | Path to Claude Code CLI |
| `CLAUDE_MODEL` | *(inherit `settings.json`)* | Default model — alias, full id, or 1M suffix (`opus[1m]`). Unset = match your terminal; `/model` overrides per chat |
| `BOT_NAME` | `Claudegram` | Bot name in system prompt |
| `STREAMING_MODE` | `streaming` | `streaming` or `wait` |
| `DANGEROUS_MODE` | `false` | Auto-approve all tool permissions |
| `CANCEL_ON_NEW_MESSAGE` | `false` | Auto-cancel running query on new message |
| `CLAUDE_SDK_LOG_LEVEL` | `off` | SDK log level: off, basic, verbose, trace |

### Reddit

| Variable | Default | Description |
|----------|---------|-------------|
| `REDDIT_CLIENT_ID` | — | Reddit OAuth2 client ID |
| `REDDIT_CLIENT_SECRET` | — | Reddit OAuth2 client secret |
| `REDDIT_USERNAME` | — | Reddit bot account username |
| `REDDIT_PASSWORD` | — | Reddit bot account password |
| `REDDIT_VIDEO_MAX_SIZE_MB` | `50` | Max video size before compression |
| `REDDITFETCH_TIMEOUT_MS` | `30000` | Execution timeout |
| `REDDITFETCH_JSON_THRESHOLD_CHARS` | `8000` | Auto-switch to JSON output |

### Medium / Freedium

| Variable | Default | Description |
|----------|---------|-------------|
| `FREEDIUM_HOST` | `freedium-mirror.cfd` | Freedium mirror host |
| `MEDIUM_TIMEOUT_MS` | `15000` | Fetch timeout |
| `MEDIUM_FILE_THRESHOLD_CHARS` | `8000` | File save threshold |

### Media Extraction

| Variable | Default | Description |
|----------|---------|-------------|
| `EXTRACT_ENABLED` | `true` | Enable /extract command |
| `YTDLP_COOKIES_PATH` | — | Netscape cookies.txt for yt-dlp |

### Voice & TTS

| Variable | Default | Description |
|----------|---------|-------------|
| `GROQ_API_KEY` | — | Groq API key for Whisper |
| `GROQ_TRANSCRIBE_PATH` | — | Path to `groq_transcribe.py` |
| `OPENAI_API_KEY` | — | OpenAI API key for TTS |
| `TTS_VOICE` | `coral` | Default TTS voice |
| `TTS_MODEL` | `gpt-4o-mini-tts` | TTS model |
| `VOICE_SHOW_TRANSCRIPT` | `true` | Show transcript text before agent response |

### OpenCode (optional)

| Variable | Default | Description |
|----------|---------|-------------|
| `OPENCODE_ENABLED` | `false` | Enable `/provider` to switch between Claude and OpenCode |
| `OPENCODE_BASE_URL` | — | URL of a running OpenCode server (else an embedded one starts) |
| `OPENCODE_PORT` | `4096` | Port for the embedded OpenCode server |

---

## Architecture

```
src/
├── bot/
│   ├── bot.ts                     # Bot setup, handler registration
│   ├── handlers/
│   │   ├── command.handler.ts     # All slash commands + inline keyboards
│   │   ├── message.handler.ts     # Text routing, ForceReply dispatch
│   │   ├── voice.handler.ts       # Voice download, transcription, agent relay
│   │   └── photo.handler.ts       # Image save + agent notification
│   └── middleware/
│       ├── auth.middleware.ts      # User whitelist + group chat auth
│       └── stale-filter.ts        # Ignore stale messages on restart
├── claude/
│   ├── agent.ts                   # Claude Agent SDK, session resume, system prompt
│   ├── mcp-tools.ts              # MCP server: Reddit, Medium, Extract, Telegraph tools
│   ├── session-manager.ts         # Per-chat session state
│   ├── session-history.ts         # Session persistence and history
│   ├── sync-log.ts                # Bot→terminal /sync sidecar (~/.claudegram/sync)
│   ├── request-queue.ts           # Per-chat sequential request queue
│   ├── command-parser.ts          # Help text + command descriptions
│   └── agent-watchdog.ts          # Watchdog for long-running agent tasks
├── reddit/
│   ├── redditfetch.ts             # Native TypeScript Reddit client (OAuth2)
│   └── vreddit.ts                 # Reddit video download + compression pipeline
├── medium/
│   └── freedium.ts                # Freedium article fetcher
├── media/
│   └── extract.ts                 # YouTube/TikTok/Instagram extraction (yt-dlp)
├── telegram/
│   ├── message-sender.ts          # Streaming, chunking, Telegraph routing
│   ├── markdown.ts                # MarkdownV2 escaping
│   ├── telegraph.ts               # Telegraph Instant View client
│   ├── telegraph-settings.ts      # Per-chat Telegraph toggle
│   ├── terminal-renderer.ts       # Terminal-style UI renderer
│   ├── terminal-settings.ts       # Per-chat terminal UI toggle
│   └── deduplication.ts           # Message dedup
├── tts/
│   ├── tts.ts                     # TTS provider routing (Groq Orpheus / OpenAI)
│   ├── tts-settings.ts            # Per-chat voice settings
│   └── voice-reply.ts             # TTS hook for agent responses
├── audio/
│   └── transcribe.ts              # Shared transcription utilities
├── utils/
│   ├── download.ts                # URL download with SSRF protection
│   ├── sanitize.ts                # Path and error sanitization
│   ├── workspace-guard.ts         # Workspace boundary enforcement
│   ├── url-guard.ts               # URL validation (protocol, SSRF)
│   ├── file-type.ts               # File content validation
│   ├── caffeinate.ts              # macOS sleep prevention
│   ├── session-key.ts             # Session key generation (DM + forum topics)
│   ├── claude-sessions.ts         # Read native ~/.claude sessions + CLI presence
│   ├── agent-timer.ts             # Agent execution timing
│   └── debug-agent.ts             # Debug utilities
├── config.ts                      # Zod-validated environment config
└── index.ts                       # Entry point
```

---

## Development

```bash
npm run dev          # Dev mode with hot reload (tsx watch)
npm run typecheck    # Type check only
npm run build        # Compile to dist/
npm start            # Run compiled build
```

### Bot Control Script

```bash
./scripts/claudegram-botctl.sh dev start      # Start dev mode
./scripts/claudegram-botctl.sh dev restart     # Restart dev
./scripts/claudegram-botctl.sh prod start      # Start production
./scripts/claudegram-botctl.sh dev log         # Tail logs
./scripts/claudegram-botctl.sh dev status      # Check if running
```

### Self-Editing Workflow

If Claudegram is editing its own codebase, use **prod mode** to avoid hot-reload restarts:

```bash
./scripts/claudegram-botctl.sh prod start      # No hot reload
# ... let Claude edit files ...
./scripts/claudegram-botctl.sh prod restart     # Apply changes
```

Then `/continue` or `/resume` in Telegram to restore your session.

---

## Security

- **User whitelist** — only approved Telegram IDs can interact
- **Project sandbox** — Claude operates within the configured working directory
- **Permission mode** — uses `acceptEdits` by default
- **Dangerous mode** — opt-in auto-approve for all tool permissions
- **Secrets** — loaded from `.env` (gitignored), never committed

---

## Credits

**Developer:** [Oleh Gavrilyuk](https://github.com/olehgavrilyuk) — native bot ⇄ terminal session unification (`/sync`), the terminal-busy collision guard with idle notifications (`/stopwait`), 1M-context model parity, and related session-continuity work.

Originally created by [NachoSEO](https://github.com/NachoSEO/claudegram), with earlier community contributions including Reddit/video downloads, voice transcription, TTS, Medium integration, Telegraph output, and image uploads.

## License

MIT
