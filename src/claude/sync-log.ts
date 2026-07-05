import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { atomicWriteFileSync } from '../utils/atomic-write.js';

/**
 * Cross-process "sync sidecar" the bot fully owns.
 *
 * The interactive Claude CLI can't reload a session's transcript while running,
 * so after each Telegram turn the bot records the exchange here. The shipped CLI
 * `/sync` command (scripts/claudegram-sync.mjs) replays the un-synced turns into
 * a live terminal session on demand.
 *
 * We own this format on purpose — Claude Code's own `.jsonl` is internal and
 * changes between versions, so we don't rely on it for the content the CLI pulls.
 */

const SYNC_DIR = path.join(os.homedir(), '.claudegram', 'sync');
const MAX_TURNS = 50;      // rolling buffer per session
const MAX_FIELD = 4096;    // cap each field to bound token cost on the CLI side
const SESSION_ID_RE = /^[a-zA-Z0-9_-]{8,128}$/;

export interface SyncTurn {
  seq: number;   // monotonic per session, preserved across pruning
  ts: number;    // epoch ms
  user: string;
  assistant: string;
}

function ensureDir(): void {
  if (!fs.existsSync(SYNC_DIR)) {
    fs.mkdirSync(SYNC_DIR, { recursive: true, mode: 0o700 });
  }
}

function fileFor(sessionId: string): string {
  return path.join(SYNC_DIR, `${sessionId}.jsonl`);
}

function cap(s: string): string {
  const text = (s || '').trim();
  return text.length > MAX_FIELD ? `${text.slice(0, MAX_FIELD - 1)}…` : text;
}

/**
 * Append one Telegram exchange to the session's sync log. Best-effort: never
 * throws (a sync-log failure must not break a chat turn).
 */
export function appendSyncTurn(sessionId: string, turn: { user: string; assistant: string }): void {
  try {
    if (!SESSION_ID_RE.test(sessionId)) return;
    ensureDir();
    const file = fileFor(sessionId);

    let lines: string[] = [];
    try {
      if (fs.existsSync(file)) {
        lines = fs.readFileSync(file, 'utf-8').split('\n').filter(Boolean);
      }
    } catch {
      lines = [];
    }

    let lastSeq = 0;
    if (lines.length > 0) {
      try {
        lastSeq = JSON.parse(lines[lines.length - 1]).seq || 0;
      } catch {
        lastSeq = lines.length;
      }
    }

    const entry: SyncTurn = {
      seq: lastSeq + 1,
      ts: Date.now(),
      user: cap(turn.user),
      assistant: cap(turn.assistant),
    };
    lines.push(JSON.stringify(entry));

    // Keep a rolling buffer; seq stays monotonic since it derives from the tail.
    if (lines.length > MAX_TURNS) {
      lines = lines.slice(lines.length - MAX_TURNS);
    }

    atomicWriteFileSync(file, `${lines.join('\n')}\n`, { mode: 0o600 });
  } catch {
    /* best-effort — swallow */
  }
}
