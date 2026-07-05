#!/usr/bin/env node
/*
 * claudegram-sync — CLI side of the bot <-> terminal `/sync` bridge.
 *
 * A live `claude` REPL never reloads a session's transcript, so it can't see
 * turns the Telegram bot added while resuming the same session id. The bot
 * records every Telegram exchange to a sidecar it owns:
 *     ~/.claudegram/sync/<sessionId>.jsonl   (lines: { seq, ts, user, assistant })
 *
 * This helper is invoked by the `/sync` slash command via `!` shell injection:
 *     !`node ".../scripts/claudegram-sync.mjs" pull --session ${CLAUDE_SESSION_ID}`
 * It prints the un-synced turns (so Claude Code injects them into the live REPL)
 * and advances a per-session cursor so repeated `/sync` calls are idempotent.
 *
 * Zero dependencies — only Node built-ins.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const SYNC_DIR = path.join(os.homedir(), '.claudegram', 'sync');
const SESSION_ID_RE = /^[a-zA-Z0-9_-]{8,128}$/;

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('--')) {
        args[key] = next;
        i++;
      } else {
        args[key] = true;
      }
    } else {
      args._.push(a);
    }
  }
  return args;
}

function fmtTime(ts) {
  try {
    return new Date(ts).toLocaleString();
  } catch {
    return String(ts);
  }
}

function pull(sessionId) {
  // Guard: unresolved substitution (older Claude Code) or garbage.
  if (!sessionId || sessionId.includes('$') || sessionId.includes('{')) {
    console.log(
      'ℹ️ Could not determine the current session id. ' +
      'This needs Claude Code v2.1.196+ (for ${CLAUDE_SESSION_ID}). Nothing to sync.'
    );
    return 0;
  }
  if (!SESSION_ID_RE.test(sessionId)) {
    console.log('ℹ️ Invalid session id — nothing to sync.');
    return 0;
  }

  const file = path.join(SYNC_DIR, `${sessionId}.jsonl`);
  const cursorFile = path.join(SYNC_DIR, `${sessionId}.cursor`);

  if (!fs.existsSync(file)) {
    console.log('✓ No Telegram activity recorded for this session yet — nothing to sync.');
    return 0;
  }

  let cursor = 0;
  try {
    if (fs.existsSync(cursorFile)) {
      cursor = parseInt(fs.readFileSync(cursorFile, 'utf-8').trim(), 10) || 0;
    }
  } catch {
    cursor = 0;
  }

  let entries = [];
  try {
    entries = fs
      .readFileSync(file, 'utf-8')
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        try {
          return JSON.parse(line);
        } catch {
          return null;
        }
      })
      .filter((e) => e && typeof e.seq === 'number');
  } catch {
    console.log('✓ Nothing to sync.');
    return 0;
  }

  const fresh = entries.filter((e) => e.seq > cursor);
  if (fresh.length === 0) {
    console.log('✓ Already in sync — no new Telegram turns since last time.');
    return 0;
  }

  const maxSeq = fresh.reduce((m, e) => Math.max(m, e.seq), cursor);

  const parts = [];
  parts.push(
    `The following ${fresh.length} exchange(s) happened via Telegram on this same ` +
    `session since your last sync. Treat them as part of our conversation:`
  );
  fresh.forEach((e, i) => {
    parts.push('');
    parts.push(`── [${i + 1}] ${fmtTime(e.ts)} ──`);
    if (e.user) parts.push(`You (via Telegram): ${e.user}`);
    if (e.assistant) parts.push(`Claude (earlier): ${e.assistant}`);
  });
  console.log(parts.join('\n'));

  // Advance the cursor so re-running /sync is idempotent.
  try {
    fs.mkdirSync(SYNC_DIR, { recursive: true });
    fs.writeFileSync(cursorFile, String(maxSeq), { mode: 0o600 });
  } catch {
    /* non-fatal: worst case we replay these turns again next /sync */
  }
  return 0;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = args._[0] || 'pull';

  if (cmd === 'pull') {
    const sessionId = typeof args.session === 'string' ? args.session.trim() : '';
    process.exit(pull(sessionId));
  }

  console.log(`Usage: claudegram-sync pull --session <sessionId>`);
  process.exit(0);
}

main();
