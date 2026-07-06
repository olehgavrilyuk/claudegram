import type { Api } from 'grammy';
import { findBusyTerminal } from '../utils/claude-sessions.js';

/**
 * Notify a Telegram chat once a busy terminal REPL finishes its turn.
 *
 * Registered only when a Telegram action was actually blocked by
 * warnIfTerminalBusy (i.e. the user tried to send while the terminal was
 * mid-turn). Since Claude Code exposes no "turn finished" event, we poll the
 * presence file (via findBusyTerminal) until the terminal goes idle/away, then
 * send a one-shot "you can go now" message.
 *
 * A watch ends in one of three ways — no arbitrary timeout:
 *   1. terminal goes idle          → send the notification
 *   2. terminal crashes/exits       → findBusyTerminal fails its pid-liveness
 *                                      check, so it reads as idle → notification
 *   3. user runs /stopwait          → cancelTerminalWait(), no notification
 */
interface Waiter {
  chatId: number;
  threadId?: number;
  sessionId: string;
  api: Api;
}

const waiters = new Map<string, Waiter>(); // key = sessionKey (one notice per chat/topic)
let timer: NodeJS.Timeout | undefined;
const POLL_MS = 4000;

/**
 * Start watching for the terminal on `sessionId` to go idle, then ping this chat.
 * No-op if this chat/topic is already waiting (dedupes repeated blocked messages).
 */
export function watchTerminalIdle(params: {
  sessionKey: string;
  chatId: number;
  threadId?: number;
  sessionId: string;
  api: Api;
}): void {
  const { sessionKey, chatId, threadId, sessionId, api } = params;
  if (waiters.has(sessionKey)) return;
  waiters.set(sessionKey, { chatId, threadId, sessionId, api });
  ensureTimer();
}

/** Cancel a pending idle-watch for this chat/topic. Returns true if one was active. */
export function cancelTerminalWait(sessionKey: string): boolean {
  const existed = waiters.delete(sessionKey);
  if (waiters.size === 0) stopTimer();
  return existed;
}

/** Is this chat/topic currently waiting for the terminal to free up? */
export function isWaitingForTerminal(sessionKey: string): boolean {
  return waiters.has(sessionKey);
}

function ensureTimer(): void {
  if (timer) return;
  timer = setInterval(poll, POLL_MS);
  // Don't keep the bot process alive solely for this poller.
  if (typeof timer.unref === 'function') timer.unref();
}

function stopTimer(): void {
  if (timer) {
    clearInterval(timer);
    timer = undefined;
  }
}

async function poll(): Promise<void> {
  if (waiters.size === 0) {
    stopTimer();
    return;
  }
  for (const [key, w] of waiters) {
    if (findBusyTerminal(w.sessionId)) continue; // still mid-turn — keep waiting

    // Terminal is idle/gone — notify once and drop the waiter.
    waiters.delete(key);
    try {
      await w.api.sendMessage(
        w.chatId,
        '✅ The terminal finished on this session — go ahead and send your message now.',
        w.threadId !== undefined ? { message_thread_id: w.threadId } : undefined
      );
    } catch {
      // Non-fatal: a failed notification shouldn't crash the poller.
    }
  }
  if (waiters.size === 0) stopTimer();
}
