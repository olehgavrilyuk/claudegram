import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/**
 * Reads native Claude Code session transcripts from ~/.claude/projects/.
 *
 * The bot drives Claude via the in-process Agent SDK, so every conversation is
 * already persisted by Claude Code itself as
 *   ~/.claude/projects/<encoded-cwd>/<session-uuid>.jsonl
 * This module lets the bot discover those sessions — including ones started in a
 * terminal — so a user can switch back and forth between terminal and Telegram
 * on one continuous thread.
 *
 * All reads are bounded (a prefix of each file) so listing stays fast even when
 * transcripts are hundreds of KB.
 */

const SESSION_ID_RE = /^[a-zA-Z0-9_-]{8,128}$/;

/** Bytes read from the head of each transcript to recover cwd + first prompt. */
const PREFIX_BYTES = 64 * 1024;
/** Upper bound on how many transcript files we read prefixes for per call. */
const MAX_FILES_SCANNED = 60;

export interface NativeSession {
  /** Session UUID (transcript filename minus .jsonl). */
  sessionId: string;
  /** Authoritative working directory recorded inside the transcript. */
  cwd: string;
  /** basename(cwd), for display. */
  projectName: string;
  /** File mtime — best available proxy for last activity. */
  modifiedAt: Date;
  /** First real user prompt, trimmed — used as a human-readable label. */
  firstPrompt?: string;
}

export interface ListNativeSessionsOptions {
  /** When set, only sessions whose recorded cwd matches this directory. */
  cwd?: string;
  /** Max sessions returned (newest first). Default 10. */
  limit?: number;
}

function projectsDir(): string {
  return path.join(os.homedir(), '.claude', 'projects');
}

/** Normalize a path for comparison (Windows is case-insensitive). */
function normalizePath(p: string): string {
  const resolved = path.resolve(p);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

/** Compare two paths for equality, accounting for platform case-sensitivity. */
export function samePath(a: string, b: string): boolean {
  return normalizePath(a) === normalizePath(b);
}

/**
 * Fold a string down to alphanumerics for a rough directory-name match.
 * Robust to Claude's cwd->dirname encoding (which replaces : \ / . with -)
 * without needing to reproduce it exactly.
 */
function foldName(s: string): string {
  return s.replace(/[^a-z0-9]/gi, '').toLowerCase();
}

/** Read up to PREFIX_BYTES from the head of a file, dropping a truncated final line. */
function readJsonlPrefix(filePath: string, maxBytes: number = PREFIX_BYTES): string {
  let fd: number | undefined;
  try {
    fd = fs.openSync(filePath, 'r');
    const buffer = Buffer.allocUnsafe(maxBytes);
    const bytesRead = fs.readSync(fd, buffer, 0, maxBytes, 0);
    let text = buffer.toString('utf-8', 0, bytesRead);
    // If we hit the cap the last line is probably truncated — drop it.
    if (bytesRead === maxBytes) {
      const lastNewline = text.lastIndexOf('\n');
      if (lastNewline !== -1) text = text.slice(0, lastNewline);
    }
    return text;
  } catch {
    return '';
  } finally {
    if (fd !== undefined) {
      try { fs.closeSync(fd); } catch { /* ignore */ }
    }
  }
}

/**
 * Slash-command / hook wrapper messages that Claude Code injects as "user"
 * turns but which are not the human's actual prompt — skipped when labelling.
 */
function isWrapperMessage(text: string): boolean {
  return /^<(local-command-|command-name|command-message|command-args|command-stdout|command-contents|system-reminder)/i.test(text.trim());
}

/** Resolve the text of a user message content field (string or content-block array). */
function extractUserText(content: unknown): string | undefined {
  if (typeof content === 'string') {
    const t = content.trim();
    return t && !isWrapperMessage(t) ? t : undefined;
  }
  if (Array.isArray(content)) {
    for (const block of content) {
      if (block && typeof block === 'object' && (block as { type?: string }).type === 'text') {
        const t = String((block as { text?: string }).text ?? '').trim();
        if (t && !isWrapperMessage(t)) return t;
      }
    }
  }
  return undefined;
}

/** Pull cwd + first real user prompt out of a transcript prefix. */
function extractFromPrefix(prefix: string): { cwd?: string; firstPrompt?: string } {
  let cwd: string | undefined;
  let firstPrompt: string | undefined;

  const lines = prefix.split('\n');
  for (const line of lines) {
    if (!line) continue;
    let entry: Record<string, unknown>;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }

    if (!cwd && typeof entry.cwd === 'string') {
      cwd = entry.cwd;
    }

    if (!firstPrompt && entry.type === 'user' && entry.isSidechain !== true) {
      const message = entry.message as { role?: string; content?: unknown } | undefined;
      if (message?.role === 'user') {
        // Skip tool_result-only turns — extractUserText returns undefined for them.
        firstPrompt = extractUserText(message.content);
      }
    }

    if (cwd && firstPrompt) break;
  }

  return { cwd, firstPrompt };
}

function truncatePrompt(prompt: string | undefined, max: number = 120): string | undefined {
  if (!prompt) return undefined;
  const oneLine = prompt.replace(/\s+/g, ' ').trim();
  if (!oneLine) return undefined;
  return oneLine.length > max ? `${oneLine.slice(0, max - 1)}…` : oneLine;
}

/**
 * List native Claude sessions from ~/.claude/projects/, newest first.
 * When opts.cwd is set, only sessions whose recorded cwd matches are returned.
 */
export function listNativeSessions(opts: ListNativeSessionsOptions = {}): NativeSession[] {
  const root = projectsDir();
  if (!fs.existsSync(root)) return [];

  const limit = opts.limit ?? 10;

  let subdirs: string[];
  try {
    subdirs = fs.readdirSync(root).filter((name) => {
      try {
        return fs.statSync(path.join(root, name)).isDirectory();
      } catch {
        return false;
      }
    });
  } catch {
    return [];
  }

  // Fast path: when filtering by cwd, prefer the subdir(s) whose folded name
  // matches the folded cwd. Fall back to scanning everything if none match.
  if (opts.cwd) {
    const foldedCwd = foldName(opts.cwd);
    const matched = subdirs.filter((name) => foldName(name) === foldedCwd);
    if (matched.length > 0) subdirs = matched;
  }

  // Gather candidate transcript files with their mtime.
  const candidates: Array<{ sessionId: string; filePath: string; modifiedAt: Date }> = [];
  for (const dir of subdirs) {
    const dirPath = path.join(root, dir);
    let files: string[];
    try {
      files = fs.readdirSync(dirPath);
    } catch {
      continue;
    }
    for (const file of files) {
      if (!file.endsWith('.jsonl')) continue;
      const sessionId = file.slice(0, -'.jsonl'.length);
      if (!SESSION_ID_RE.test(sessionId)) continue;
      const filePath = path.join(dirPath, file);
      try {
        const stat = fs.statSync(filePath);
        if (!stat.isFile()) continue;
        candidates.push({ sessionId, filePath, modifiedAt: stat.mtime });
      } catch {
        continue;
      }
    }
  }

  // Read prefixes for the most-recent candidates only.
  candidates.sort((a, b) => b.modifiedAt.getTime() - a.modifiedAt.getTime());

  const sessions: NativeSession[] = [];
  for (const candidate of candidates.slice(0, MAX_FILES_SCANNED)) {
    const { cwd, firstPrompt } = extractFromPrefix(readJsonlPrefix(candidate.filePath));
    if (!cwd) continue;
    if (opts.cwd && !samePath(cwd, opts.cwd)) continue;
    sessions.push({
      sessionId: candidate.sessionId,
      cwd,
      projectName: path.basename(cwd),
      modifiedAt: candidate.modifiedAt,
      firstPrompt: truncatePrompt(firstPrompt),
    });
  }

  sessions.sort((a, b) => b.modifiedAt.getTime() - a.modifiedAt.getTime());
  return sessions.slice(0, limit);
}

/**
 * A currently-running Claude process, from ~/.claude/sessions/<pid>.json.
 * NOTE: this file layout is an undocumented Claude Code internal — treated
 * best-effort and may change between versions.
 */
export interface ActiveProcess {
  pid: number;
  sessionId?: string;
  cwd?: string;
  kind?: string;       // e.g. "interactive"
  entrypoint?: string; // e.g. "cli" | "sdk"
  status?: string;     // e.g. "busy" | "idle"
  name?: string;
  updatedAt: number;   // epoch ms of last heartbeat
}

/**
 * Default freshness window. NOTE: these files record last *activity*, not a live
 * heartbeat — a session actively open but idle can show an old `updatedAt` and a
 * stale `status`. So this is a "recently active" window, not proof of liveness.
 */
export const PRESENCE_FRESH_MS = 30 * 60_000;

/**
 * Find the freshest running Claude process matching a session id and/or cwd,
 * within the freshness window. Returns undefined if none (or the presence dir
 * is absent). Undocumented format → fully defensive.
 */
export function findActiveProcess(
  opts: { sessionId?: string; cwd?: string; staleMs?: number } = {}
): ActiveProcess | undefined {
  const dir = path.join(os.homedir(), '.claude', 'sessions');
  if (!fs.existsSync(dir)) return undefined;

  let files: string[];
  try {
    files = fs.readdirSync(dir).filter((f) => f.endsWith('.json'));
  } catch {
    return undefined;
  }

  const staleMs = opts.staleMs ?? PRESENCE_FRESH_MS;
  const now = Date.now();
  const matches: ActiveProcess[] = [];

  for (const file of files) {
    let p: Record<string, unknown>;
    try {
      p = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf-8'));
    } catch {
      continue;
    }
    if (opts.sessionId && p.sessionId !== opts.sessionId) continue;
    if (opts.cwd && !(typeof p.cwd === 'string' && samePath(p.cwd, opts.cwd))) continue;
    if (typeof p.pid === 'number' && p.pid === process.pid) continue; // skip self

    const updatedAt = typeof p.updatedAt === 'number'
      ? p.updatedAt
      : (typeof p.startedAt === 'number' ? p.startedAt : 0);
    if (now - updatedAt > staleMs) continue;

    matches.push({
      pid: typeof p.pid === 'number' ? p.pid : -1,
      sessionId: typeof p.sessionId === 'string' ? p.sessionId : undefined,
      cwd: typeof p.cwd === 'string' ? p.cwd : undefined,
      kind: typeof p.kind === 'string' ? p.kind : undefined,
      entrypoint: typeof p.entrypoint === 'string' ? p.entrypoint : undefined,
      status: typeof p.status === 'string' ? p.status : undefined,
      name: typeof p.name === 'string' ? p.name : undefined,
      updatedAt,
    });
  }

  matches.sort((a, b) => b.updatedAt - a.updatedAt);
  return matches[0];
}

/**
 * Locate a specific session transcript by id and return its working directory.
 */
export function findSessionOnDisk(
  sessionId: string
): { workingDirectory: string; projectName: string } | undefined {
  if (!SESSION_ID_RE.test(sessionId)) return undefined;
  const root = projectsDir();
  if (!fs.existsSync(root)) return undefined;

  let subdirs: string[];
  try {
    subdirs = fs.readdirSync(root);
  } catch {
    return undefined;
  }

  for (const dir of subdirs) {
    const dirPath = path.join(root, dir);
    const sessionFile = path.join(dirPath, `${sessionId}.jsonl`);
    try {
      if (!fs.existsSync(sessionFile)) continue;
    } catch {
      continue;
    }
    const { cwd } = extractFromPrefix(readJsonlPrefix(sessionFile));
    if (cwd) {
      return { workingDirectory: cwd, projectName: path.basename(cwd) };
    }
  }
  return undefined;
}
