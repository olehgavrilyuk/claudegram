import {
  query,
  type SDKMessage,
  type SDKUserMessage,
  type SDKResultMessage,
  type SDKCompactBoundaryMessage,
  type SDKStatusMessage,
  type SDKSystemMessage,
  type PermissionMode,
  type SettingSource,
  type HookEvent,
  type HookCallbackMatcher,
  type McpServerConfig,
} from '@anthropic-ai/claude-agent-sdk';
import * as fs from 'fs';
import { sessionManager } from './session-manager.js';
import { setActiveQuery, clearActiveQuery, isCancelled } from './request-queue.js';
import type { Context } from 'grammy';
import { config } from '../config.js';
import { AgentWatchdog } from './agent-watchdog.js';
import { createClaudegramMcpServer } from './mcp-tools.js';
import {
  createAgentTimer,
  recordMessage,
  formatDuration,
  getElapsedMs,
  getTimingReport,
  type AgentTimer,
} from '../utils/agent-timer.js';
import { userPreferences } from '../providers/user-preferences.js';
import { BoundedMap } from '../utils/bounded-map.js';
import { appendSyncTurn } from './sync-log.js';

import type { AgentUsage, AgentResponse, AgentOptions, LoopOptions, ImageAttachment } from '../providers/types.js';
export type { AgentUsage };

interface ConversationMessage {
  role: 'user' | 'assistant';
  content: string;
}

const conversationHistory = new BoundedMap<string, ConversationMessage[]>(1000);

// Track Claude Code session IDs per session for conversation continuity
const chatSessionIds = new BoundedMap<string, string>(1000);

// Track current model per session (default: opus)
// chatModels is intentionally unbounded — it's backed by persistent preferences
const chatModels = new Map<string, string>();

// Cache latest usage per session for /context and /status commands
const chatUsageCache = new BoundedMap<string, AgentUsage>(1000);

export function getCachedUsage(sessionKey: string): AgentUsage | undefined {
  return chatUsageCache.get(sessionKey);
}

/**
 * Build a multimodal prompt with image content blocks for the Claude SDK.
 * The SDK accepts `prompt: string | AsyncIterable<SDKUserMessage>`.
 * When images are attached, we use the AsyncIterable form to send
 * content blocks (image + text) in a single user message.
 */
async function* buildMultimodalPrompt(
  text: string,
  images: ImageAttachment[],
  sessionId?: string,
): AsyncGenerator<SDKUserMessage> {
  const contentBlocks: Array<
    | { type: 'image'; source: { type: 'base64'; media_type: string; data: string } }
    | { type: 'text'; text: string }
  > = [];

  for (const img of images) {
    contentBlocks.push({
      type: 'image',
      source: {
        type: 'base64',
        media_type: img.mediaType,
        data: img.data,
      },
    });
  }

  contentBlocks.push({ type: 'text', text });

  yield {
    type: 'user',
    message: { role: 'user', content: contentBlocks },
    parent_tool_use_id: null,
    session_id: sessionId || '',
  } as SDKUserMessage;
}

const CORE_GUIDELINES = `You are ${config.BOT_NAME}, an AI assistant helping via Telegram.

Guidelines:
- Show relevant code snippets when helpful, but keep them short
- If a task requires multiple steps, execute them and summarize what you did
- When you can't do something, explain why briefly`;

const TELEGRAPH_FORMATTING = `

Response Formatting — Telegraph-Aware Writing:
Your responses are displayed via Telegram. Short responses render inline as MarkdownV2.
Longer responses (2500+ chars) are published as Telegraph (telegra.ph) Instant View pages.
You MUST write with Telegraph's rendering constraints in mind at all times.

Telegraph supports ONLY these elements:
- Headings: h3 (from # and ##) and h4 (from ### and ####). No h1, h2, h5, h6.
- Text formatting: **bold**, *italic*, ~~strikethrough~~, \`inline code\`
- Links: [text](url)
- Lists: unordered (- item) and ordered (1. item). Nested lists are supported (indent sub-items).
- Code blocks: \`\`\`code\`\`\` — rendered as monospace preformatted text. No syntax highlighting.
- Blockquotes: > text
- Horizontal rules: ---

Telegraph does NOT support:
- TABLES — pipe-delimited markdown tables (|col|col|) will NOT render as tables. They break into ugly labeled text. NEVER use markdown tables.
- No checkboxes, footnotes, or task lists
- No custom colors, fonts, or inline styles
- Only two heading levels (h3, h4)

Instead of tables, use these alternatives (in order of preference):
1. Bullet lists with bold labels — best for key-value data or comparisons:
   - **Name**: Alice
   - **Age**: 30
   - **City**: NYC

2. Nested lists — best for grouped/categorized data:
   - **Frontend**
     - React 18
     - TypeScript
   - **Backend**
     - Node.js
     - Express

3. Bold headers with list items — best for feature/comparison matrices:
   **Telegram bot** — Grammy v1.31
   **AI agent** — Claude Code SDK v1.0
   **TTS** — OpenAI gpt-4o-mini-tts

4. Preformatted code blocks — ONLY for data where alignment matters (ASCII tables):
   \`\`\`
   Name      Age   City
   Alice     30    NYC
   Bob       25    London
   \`\`\`
   Note: code blocks lose all formatting (no bold, links, etc.) so only use when alignment is critical.

Structure guidelines for long responses:
- Use ## or ### headings to create clear sections (renders as h3/h4)
- Use --- horizontal rules to separate major sections
- Use bullet lists liberally — they render cleanly
- Use > blockquotes for callouts, warnings, or important notes
- Keep paragraphs concise; Telegraph renders best with short blocks of text
- Nest sub-items under list items for tree-like structures instead of indented text`;

const INLINE_FORMATTING = `

Response Formatting:
Your responses are displayed via Telegram using MarkdownV2 formatting.
Long responses are automatically chunked into multiple messages.

Supported formatting:
- **bold**, *italic*, ~~strikethrough~~, \`inline code\`
- Links: [text](url)
- Lists: unordered (- item) and ordered (1. item)
- Code blocks: \`\`\`code\`\`\`
- Blockquotes: > text

Instead of tables (which don't render well in Telegram), use bullet lists with bold labels:
- **Name**: Alice
- **Age**: 30
- **City**: NYC`;

const BASE_SYSTEM_PROMPT = CORE_GUIDELINES + (config.TELEGRAPH_ENABLED ? TELEGRAPH_FORMATTING : INLINE_FORMATTING);

const REDDIT_TOOL_PROMPT = `

Reddit Tool:
You have a claudegram_fetch_reddit MCP tool that fetches Reddit content directly (subreddits, posts with comments, user profiles).
Use it when the user asks about Reddit content — no need to tell them to use a command.
The tool accepts a target (r/<subreddit>, u/<username>, post URL, post ID) and optional sort/time/limit/depth parameters.

Semantic mappings for natural language Reddit queries:
- "today" / "today's top" → sort: top, time_filter: day
- "newest" / "latest" / "recent" → sort: new
- "hottest" / "trending" / "what's hot" → sort: hot
- "top" / "best" → sort: top
- "this week" → sort: top, time_filter: week
- "this month" → sort: top, time_filter: month
- "rising" → sort: rising

The user also has a /reddit Telegram command for direct use.`;

const REDDIT_VIDEO_TOOL_PROMPT = `

Reddit Video Tool:
The user can download Reddit-hosted videos via the /vreddit Telegram command.
If the user wants a video file, tell them to use /vreddit with the post URL.
The claudegram_fetch_reddit tool is for text/comments only, not media downloads.`;

const MEDIUM_TOOL_PROMPT = `

Medium Tool:
You have a claudegram_fetch_medium MCP tool that fetches Medium articles (bypasses paywall via Freedium).
Use it when the user shares a Medium URL or asks to read an article — no need to tell them to use a command.
The user also has a /medium Telegram command for direct use.`;

const EXTRACT_TOOL_PROMPT = `

Media Extract Tool:
You have a claudegram_extract_media MCP tool that extracts content from YouTube, Instagram, and TikTok URLs.
Use mode "text" to transcribe videos, "audio" for MP3, "video" for MP4, "all" for everything.
Audio/video files are sent directly to the user via Telegram as a side effect.
Use it when the user asks to transcribe, download, or extract media from a URL — no need to tell them to use a command.
For voice notes sent directly in chat, the user should use /transcribe instead.
The user also has an /extract Telegram command for direct use.`;

const REASONING_SUMMARY_INSTRUCTIONS = `

Reasoning Summary (required when enabled):
- At the end of each response, add a short section titled "Reasoning Summary".
- Provide 2–5 bullet points describing high-level actions/decisions taken.
- Do NOT reveal chain-of-thought, hidden reasoning, or sensitive tool outputs.
- Skip the summary for very short acknowledgements or pure error messages.`;

const TOOL_PROMPTS = [
  config.REDDIT_ENABLED ? REDDIT_TOOL_PROMPT : '',
  config.VREDDIT_ENABLED ? REDDIT_VIDEO_TOOL_PROMPT : '',
  config.MEDIUM_ENABLED ? MEDIUM_TOOL_PROMPT : '',
  config.EXTRACT_ENABLED ? EXTRACT_TOOL_PROMPT : '',
].join('');

const SYSTEM_PROMPT = `${BASE_SYSTEM_PROMPT}${TOOL_PROMPTS}${config.CLAUDE_REASONING_SUMMARY ? REASONING_SUMMARY_INSTRUCTIONS : ''}`;

/**
 * Strip the "Reasoning Summary" section from the end of a response
 * so it doesn't appear in Telegram chat (it's already in logs).
 */
function stripReasoningSummary(text: string): string {
  // Match a trailing reasoning summary block:
  //   ---\n**Reasoning Summary**\n... (to end)
  //   or: **Reasoning Summary**\n... (to end)
  //   or: *Reasoning Summary*\n... (to end)
  return text.replace(/\n*(?:---\n+)?(?:\*{1,2})Reasoning Summary(?:\*{1,2})\n[\s\S]*$/, '').trimEnd();
}

type LogLevel = 'off' | 'basic' | 'verbose' | 'trace';
const LOG_LEVELS: Record<LogLevel, number> = {
  off: 0,
  basic: 1,
  verbose: 2,
  trace: 3,
};

function getLogLevel(): LogLevel {
  return config.CLAUDE_SDK_LOG_LEVEL as LogLevel;
}

function logAt(level: LogLevel, message: string, data?: unknown): void {
  if (LOG_LEVELS[level] <= LOG_LEVELS[getLogLevel()]) {
    if (data !== undefined) {
      console.log(message, data);
    } else {
      console.log(message);
    }
  }
}

function getPermissionMode(command?: string): PermissionMode {
  // If DANGEROUS_MODE is enabled, bypass all permissions
  if (config.DANGEROUS_MODE) {
    return 'bypassPermissions';
  }

  // Otherwise, use command-specific modes
  if (command === 'plan') {
    return 'plan';
  }

  return 'acceptEdits';
}

/**
 * Log operations when DANGEROUS_MODE is enabled for security auditing.
 */
function logDangerousModeOperation(sessionKey: string, operation: string, details?: string): void {
  if (!config.DANGEROUS_MODE) return;
  const timestamp = new Date().toISOString();
  const detailStr = details ? ` — ${details}` : '';
  console.log(`[DANGEROUS_MODE] ${timestamp} session:${sessionKey} ${operation}${detailStr}`);
}

export async function sendToAgent(
  sessionKey: string,
  message: string,
  options: AgentOptions = {}
): Promise<AgentResponse> {
  const { onProgress, onToolStart, onToolEnd, abortController, command, model, images } = options;

  const session = sessionManager.getSession(sessionKey);

  if (!session) {
    throw new Error('No active session. Use /project to set working directory.');
  }

  sessionManager.updateActivity(sessionKey, message);

  // Get or initialize conversation history
  let history = conversationHistory.get(sessionKey) || [];

  // Determine the prompt based on command
  let prompt = message;
  if (command === 'explore') {
    prompt = `Explore the codebase and answer: ${message}`;
  }

  // Add user message to history
  history.push({
    role: 'user',
    content: prompt,
  });

  let fullText = '';
  const toolsUsed: string[] = [];
  let gotResult = false;
  let resultUsage: AgentUsage | undefined;
  let compactionEvent: { trigger: 'manual' | 'auto'; preTokens: number } | undefined;
  let initEvent: { model: string; sessionId: string } | undefined;

  // Determine permission mode
  const permissionMode = getPermissionMode(command);

  // Log in dangerous mode for security auditing
  logDangerousModeOperation(sessionKey, 'query', `prompt_length:${message.length} cwd:${session.workingDirectory}`);

  // Determine model. Priority: explicit per-call > per-chat preference
  // (in-memory or persisted) > CLAUDE_MODEL env. If none, leave it undefined so
  // the SDK inherits the model from ~/.claude/settings.json (via settingSources).
  // This keeps the bot on the SAME model + context window the terminal uses
  // (e.g. a 1M "[1m]" model), so resuming a large session doesn't overflow a
  // forced 200K default with "Prompt is too long".
  const numericChatId = parseInt(sessionKey, 10);
  const effectiveModel =
    model
    || chatModels.get(sessionKey)
    || (Number.isNaN(numericChatId) ? undefined : userPreferences.getModel(numericChatId))
    || config.CLAUDE_MODEL;

  // Initialize timer for tracking query duration (watchdog created inside try with controller)
  const timer = createAgentTimer();
  let watchdog: AgentWatchdog | null = null;

  try {
    const controller = abortController || new AbortController();

    const existingSessionId = chatSessionIds.get(sessionKey) || session.claudeSessionId;

    // Log session resume if applicable
    if (existingSessionId) {
      if (!chatSessionIds.get(sessionKey)) {
        chatSessionIds.set(sessionKey, existingSessionId);
      }
      logAt('basic', `[Claude] Resuming session ${existingSessionId} for session ${sessionKey}`);
    }

    const toolsOption = config.DANGEROUS_MODE
      ? { type: 'preset' as const, preset: 'claude_code' as const }
      : ['Bash', 'Read', 'Write', 'Edit', 'Glob', 'Grep', 'Task'];

    const allowedToolsOption = config.DANGEROUS_MODE
      ? undefined
      : ['Bash', 'Read', 'Write', 'Edit', 'Glob', 'Grep', 'Task'];

    // PreCompact hook always registered (logging only — notification sent from compact_boundary message)
    const preCompactHook: Partial<Record<HookEvent, HookCallbackMatcher[]>> = {
      PreCompact: [{
        hooks: [async (input) => {
          logAt('basic', '[Hook] PreCompact — context is about to be compacted', {
            trigger: (input as Record<string, unknown>).trigger,
            customInstructions: (input as Record<string, unknown>).custom_instructions,
          });
          return { continue: true };
        }],
      }],
    };

    // SDK hook logging: only register the noisy hooks (PreToolUse, PostToolUse, etc.)
    // when LOG_AGENT_HOOKS is true. Session lifecycle hooks are always registered.
    const verboseHooks: Partial<Record<HookEvent, HookCallbackMatcher[]>> = config.LOG_AGENT_HOOKS
      ? {
        PreToolUse: [{
          hooks: [async (input) => {
            logAt('verbose', '[Hook] PreToolUse', input);
            return { continue: true };
          }],
        }],
        PostToolUse: [{
          hooks: [async (input) => {
            logAt('verbose', '[Hook] PostToolUse', input);
            return { continue: true };
          }],
        }],
        PostToolUseFailure: [{
          hooks: [async (input) => {
            logAt('verbose', '[Hook] PostToolUseFailure', input);
            return { continue: true };
          }],
        }],
        PermissionRequest: [{
          hooks: [async (input) => {
            logAt('verbose', '[Hook] PermissionRequest', input);
            return { continue: true };
          }],
        }],
        Notification: [{
          hooks: [async (input) => {
            logAt('verbose', '[Hook] Notification', input);
            return { continue: true };
          }],
        }],
      }
      : {};

    const hooks: Partial<Record<HookEvent, HookCallbackMatcher[]>> | undefined =
      LOG_LEVELS[getLogLevel()] >= LOG_LEVELS.verbose
        ? {
          ...preCompactHook,
          ...verboseHooks,
          SessionStart: [{
            hooks: [async (input) => {
              logAt('basic', '[Hook] SessionStart', input);
              return { continue: true };
            }],
          }],
          SessionEnd: [{
            hooks: [async (input) => {
              logAt('basic', '[Hook] SessionEnd', input);
              return { continue: true };
            }],
          }],
        }
        : preCompactHook;

    // Validate cwd exists — stale sessions may reference paths from another OS
    let cwd = session.workingDirectory;
    try {
      if (!fs.existsSync(cwd)) {
        const fallback = process.env.HOME || process.cwd();
        console.warn(`[Claude] Working directory does not exist: ${cwd}, falling back to ${fallback}`);
        cwd = fallback;
      }
    } catch {
      cwd = process.env.HOME || process.cwd();
    }

    // Create MCP server for Claudegram tools (if telegramCtx is available)
    const mcpServers: Record<string, McpServerConfig> = {};
    if (options.telegramCtx) {
      const server = createClaudegramMcpServer({
        telegramCtx: options.telegramCtx as Context,
        sessionKey,
      });
      mcpServers['claudegram-tools'] = server;
    }

    const queryOptions: Parameters<typeof query>[0]['options'] = {
      cwd,
      tools: toolsOption,
      ...(allowedToolsOption ? { allowedTools: allowedToolsOption } : {}),
      permissionMode,
      abortController: controller,
      systemPrompt: {
        type: 'preset' as const,
        preset: 'claude_code' as const,
        append: SYSTEM_PROMPT,
      },
      settingSources: ['project', 'user'] as SettingSource[],
      // Omit when undefined so the SDK falls back to ~/.claude/settings.json.
      ...(effectiveModel ? { model: effectiveModel } : {}),
      resume: existingSessionId,
      ...(permissionMode === 'bypassPermissions' ? { allowDangerouslySkipPermissions: true } : {}),
      ...(config.CLAUDE_USE_BUNDLED_EXECUTABLE ? {} : { pathToClaudeCodeExecutable: config.CLAUDE_EXECUTABLE_PATH }),
      includePartialMessages: config.CLAUDE_SDK_INCLUDE_PARTIAL || getLogLevel() === 'trace',
      hooks,
      ...(Object.keys(mcpServers).length > 0 ? { mcpServers } : {}),
      stderr: (data: string) => {
        console.error('[Claude stderr]:', data);
      },
    };

    const multimodalPrompt = images?.length
      ? buildMultimodalPrompt(prompt, images, existingSessionId)
      : undefined;

    const response = query({
      prompt: multimodalPrompt || prompt,
      options: queryOptions,
    });

    // Store the Query object so /cancel can call interrupt()
    setActiveQuery(sessionKey, response);

    // Initialize watchdog for long-running query monitoring
    watchdog = config.AGENT_WATCHDOG_ENABLED
      ? new AgentWatchdog({
          chatId: sessionKey,
          warnAfterSeconds: config.AGENT_WATCHDOG_WARN_SECONDS,
          logIntervalSeconds: config.AGENT_WATCHDOG_LOG_SECONDS,
          timeoutMs: config.AGENT_QUERY_TIMEOUT_MS > 0 ? config.AGENT_QUERY_TIMEOUT_MS : undefined,
          onWarning: (sinceMsg, total) => {
            logAt('basic', `[Claude] WATCHDOG: No messages for ${formatDuration(sinceMsg)} (total: ${formatDuration(total)}), session:${sessionKey}`);
          },
          onTimeout: () => {
            logAt('basic', `[Claude] WATCHDOG: Query timeout reached, aborting session:${sessionKey}`);
            controller.abort();
          },
        })
      : null;
    watchdog?.start();

    // Process response messages
    for await (const responseMessage of response) {
      // Record activity for watchdog
      recordMessage(timer);
      watchdog?.recordActivity(responseMessage.type);

      // Check for abort
      if (controller.signal.aborted) {
        watchdog?.stop();
        fullText = '🛑 Request cancelled.';
        break;
      }

      logAt('trace', `[Claude] [${formatDuration(getElapsedMs(timer))}] Message: ${responseMessage.type}`);

      if (responseMessage.type === 'assistant') {
        logAt('verbose', '[Claude] Assistant content blocks:', responseMessage.message.content.length);
        for (const block of responseMessage.message.content) {
          logAt('trace', '[Claude] Block type:', block.type);
          if (block.type === 'text') {
            fullText += block.text;
            onProgress?.(fullText);
          } else if (block.type === 'tool_use') {
            const toolInput = 'input' in block ? block.input as Record<string, unknown> : {};
            const inputSummary = toolInput.command
              ? String(toolInput.command).substring(0, 150)
              : toolInput.pattern
                ? String(toolInput.pattern)
                : toolInput.file_path
                  ? String(toolInput.file_path)
                  : '';
            logAt('verbose', `[Claude] [${formatDuration(getElapsedMs(timer))}] Tool: ${block.name}${inputSummary ? ` → ${inputSummary}` : ''}`);
            toolsUsed.push(block.name);
            // Special logging for Task tool (subagents) - always log at basic level
            if (block.name === 'Task') {
              const taskDesc = toolInput.description || toolInput.prompt || 'unnamed task';
              const subagentType = toolInput.subagent_type || 'unknown';
              logAt('basic', `[Claude] SUBAGENT START: ${subagentType} — ${String(taskDesc).substring(0, 100)}`);
            }
            // Notify tool start for terminal UI
            onToolStart?.(block.name, toolInput);
          }
        }
      } else if (responseMessage.type === 'system') {
        if (responseMessage.subtype === 'compact_boundary') {
          const cbMsg = responseMessage as SDKCompactBoundaryMessage;
          compactionEvent = {
            trigger: cbMsg.compact_metadata.trigger,
            preTokens: cbMsg.compact_metadata.pre_tokens,
          };
          logAt('basic', `[Claude] COMPACTION: trigger=${cbMsg.compact_metadata.trigger}, pre_tokens=${cbMsg.compact_metadata.pre_tokens}`);
        } else if (responseMessage.subtype === 'init') {
          const sysMsg = responseMessage as SDKSystemMessage;
          initEvent = {
            model: sysMsg.model,
            sessionId: sysMsg.session_id,
          };
          logAt('basic', `[Claude] SESSION INIT: model=${sysMsg.model}, session=${sysMsg.session_id}`);
        } else if (responseMessage.subtype === 'status') {
          const statusMsg = responseMessage as SDKStatusMessage;
          if (statusMsg.status === 'compacting') {
            logAt('basic', '[Claude] STATUS: compacting in progress');
          }
        } else {
          logAt('verbose', `[Claude] System: ${responseMessage.subtype ?? 'unknown'}`, responseMessage);
        }
      } else if (responseMessage.type === 'tool_progress') {
        logAt('verbose', `[Claude] Tool progress: ${responseMessage.tool_name}`, responseMessage);
      } else if (responseMessage.type === 'tool_use_summary') {
        logAt('verbose', '[Claude] Tool use summary', responseMessage);
        // Notify tool end for terminal UI (summary doesn't include tool name)
        onToolEnd?.();
      } else if (responseMessage.type === 'auth_status') {
        logAt('basic', '[Claude] Auth status', responseMessage);
      } else if (responseMessage.type === 'stream_event') {
        logAt('trace', '[Claude] Stream event', responseMessage.event);
      } else if (responseMessage.type === 'result') {
        watchdog?.stop();
        logAt('basic', `[Claude] Query completed: ${getTimingReport(timer)}`);
        logAt('verbose', '[Claude] Result:', JSON.stringify(responseMessage, null, 2).substring(0, 500));
        gotResult = true;

        // Extract usage data from result
        const resultMsg = responseMessage as SDKResultMessage;
        if (resultMsg.modelUsage) {
          const modelKey = Object.keys(resultMsg.modelUsage)[0];
          if (modelKey && resultMsg.modelUsage[modelKey]) {
            const mu = resultMsg.modelUsage[modelKey];
            resultUsage = {
              inputTokens: mu.inputTokens,
              outputTokens: mu.outputTokens,
              cacheReadTokens: mu.cacheReadInputTokens,
              cacheWriteTokens: mu.cacheCreationInputTokens,
              totalCostUsd: resultMsg.total_cost_usd,
              contextWindow: mu.contextWindow,
              numTurns: resultMsg.num_turns,
              model: modelKey,
            };
          }
        }

        if (responseMessage.subtype === 'success' && !responseMessage.is_error) {
          // Only store session_id on successful results (not on error_during_execution)
          if ('session_id' in responseMessage && responseMessage.session_id) {
            chatSessionIds.set(sessionKey, responseMessage.session_id);
            sessionManager.setClaudeSessionId(sessionKey, responseMessage.session_id);
            logAt('basic', `[Claude] Stored session ${responseMessage.session_id} for session ${sessionKey}`);
          }

          // Append final result text if different from accumulated
          if (responseMessage.result && !fullText.includes(responseMessage.result)) {
            if (fullText.length > 0) {
              fullText += '\n\n';
            }
            fullText += responseMessage.result;
            onProgress?.(fullText);
          }
        } else if (responseMessage.subtype === 'success' && responseMessage.is_error) {
          // The SDK returns subtype 'success' with is_error:true for API-level
          // failures (e.g. "Prompt is too long" when a resumed session overflows
          // the context window). Don't pass the error text off as Claude's answer,
          // and clear the session so the next message auto-recovers with a fresh
          // one. Clearing the id also skips the sync-sidecar write below.
          chatSessionIds.delete(sessionKey);
          const session = sessionManager.getSession(sessionKey);
          if (session) {
            session.claudeSessionId = undefined;
          }
          const errText = responseMessage.result || 'Unknown error';
          logAt('basic', `[Claude] Result error (is_error) for session ${sessionKey}: ${errText}`);
          fullText = /too long|context/i.test(errText)
            ? "⚠️ This conversation hit Claude's context limit, so I've started a fresh session for this project. Your earlier messages are safe — resend your last message, or use /clear."
            : `⚠️ ${errText}`;
          onProgress?.(fullText);
        } else if (responseMessage.subtype === 'error_during_execution' && isCancelled(sessionKey)) {
          // Interrupted via /cancel - show clean cancellation message
          fullText = '✅ Successfully cancelled - no tools or agents in process.';
          onProgress?.(fullText);
        } else {
          // Any other result error (SDKResultError): max_turns, max_budget,
          // structured-output retries, or an unexpected execution error.
          const subtype = responseMessage.subtype;
          const recoverable = subtype === 'error_max_turns' || subtype === 'error_max_budget_usd';
          const details = ('errors' in responseMessage && Array.isArray(responseMessage.errors) && responseMessage.errors.length)
            ? responseMessage.errors.join('; ')
            : '';

          if (recoverable) {
            // The session is intact — just capped. Keep it resumable so the user
            // can send "continue" and pick up exactly where Claude left off.
            if ('session_id' in responseMessage && responseMessage.session_id) {
              chatSessionIds.set(sessionKey, responseMessage.session_id);
              sessionManager.setClaudeSessionId(sessionKey, responseMessage.session_id);
            }
          } else {
            // Unexpected error — reset so the next message starts fresh.
            chatSessionIds.delete(sessionKey);
            const session = sessionManager.getSession(sessionKey);
            if (session) {
              session.claudeSessionId = undefined;
            }
          }
          logAt('basic', `[Claude] Result error for session ${sessionKey}: ${subtype}${details ? ` — ${details}` : ''}`);

          const notice =
            subtype === 'error_max_turns'
              ? '⚠️ I reached my step limit for a single request before finishing. Send "continue" and I\'ll pick up where I left off — or break the task into smaller steps.'
              : subtype === 'error_max_budget_usd'
                ? '⚠️ This request hit its cost limit before finishing. Send "continue" to keep going.'
                : details
                  ? `⚠️ Something went wrong while running that:\n${details}\n\nI've reset this session — please try again.`
                  : "⚠️ Something went wrong while running that request. I've reset this session — please try again, or use /clear.";

          // Preserve any work already streamed; append the notice rather than replace.
          fullText = fullText.trim() ? `${fullText}\n\n${notice}` : notice;
          onProgress?.(fullText);
        }
      }
    }
  } catch (error) {
    watchdog?.stop();
    // If cancelled via /cancel or /reset, return clean message
    if (isCancelled(sessionKey) || abortController?.signal.aborted) {
      return {
        text: '✅ Successfully cancelled - no tools or agents in process.',
        toolsUsed,
      };
    }

    // If we got a result, ignore process exit errors (SDK quirk)
    if (gotResult && error instanceof Error && error.message.includes('exited with code')) {
      console.log('[Claude] Ignoring exit code error after successful result');
    } else {
      console.error('[Claude] Full error:', error);
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      throw new Error(`Claude error: ${errorMessage}`);
    }
  } finally {
    watchdog?.stop();
    clearActiveQuery(sessionKey);
  }

  // Add assistant response to history
  if (fullText && !abortController?.signal.aborted) {
    history.push({
      role: 'assistant',
      content: fullText,
    });
  }

  conversationHistory.set(sessionKey, history);

  // Cache usage for /context and /status commands
  if (resultUsage) {
    chatUsageCache.set(sessionKey, resultUsage);
  }

  // Record this exchange to the cross-process sync sidecar so the terminal's
  // `/sync` command can replay it into a live CLI session. Best-effort only.
  const syncedSessionId = chatSessionIds.get(sessionKey);
  if (syncedSessionId && fullText && !abortController?.signal.aborted && !isCancelled(sessionKey)) {
    appendSyncTurn(syncedSessionId, {
      user: message,
      assistant: stripReasoningSummary(fullText),
    });
  }

  return {
    text: stripReasoningSummary(fullText) || 'No response from Claude.',
    toolsUsed,
    usage: resultUsage,
    compaction: compactionEvent,
    sessionInit: initEvent,
  };
}

export async function sendLoopToAgent(
  sessionKey: string,
  message: string,
  options: LoopOptions = {}
): Promise<AgentResponse> {
  const {
    onProgress,
    abortController,
    maxIterations = config.MAX_LOOP_ITERATIONS,
    onIterationComplete,
  } = options;

  const session = sessionManager.getSession(sessionKey);

  if (!session) {
    throw new Error('No active session. Use /project to set working directory.');
  }

  // Wrap the prompt with loop instructions
  const loopPrompt = `${message}

IMPORTANT: When you have fully completed this task, respond with the word "DONE" on its own line at the end of your response. If you need to continue working, do not say "DONE".`;

  let iteration = 0;
  let combinedText = '';
  const allToolsUsed: string[] = [];
  let isComplete = false;

  while (iteration < maxIterations && !isComplete) {
    iteration++;

    // Check for abort
    if (abortController?.signal.aborted) {
      return {
        text: '🛑 Loop cancelled.',
        toolsUsed: allToolsUsed,
      };
    }

    const iterationPrefix = `\n\n--- Iteration ${iteration}/${maxIterations} ---\n\n`;
    combinedText += iterationPrefix;
    onProgress?.(combinedText);

    // For subsequent iterations, prompt Claude to continue
    const currentPrompt = iteration === 1 ? loopPrompt : 'Continue the task. Say "DONE" when complete.';

    try {
      const response = await sendToAgent(sessionKey, currentPrompt, {
        onProgress: (text) => {
          onProgress?.(combinedText + text);
        },
        abortController,
        model: options.model,
        telegramCtx: options.telegramCtx,
      });

      combinedText += response.text;
      allToolsUsed.push(...response.toolsUsed);

      onIterationComplete?.(iteration, response.text);

      // Check if Claude said DONE
      if (response.text.includes('DONE')) {
        isComplete = true;
        combinedText += '\n\n✅ Loop completed.';
      } else if (iteration >= maxIterations) {
        combinedText += `\n\n⚠️ Max iterations (${maxIterations}) reached.`;
      }

      onProgress?.(combinedText);
    } catch (error) {
      if (abortController?.signal.aborted) {
        return {
          text: combinedText + '\n\n🛑 Loop cancelled.',
          toolsUsed: allToolsUsed,
        };
      }
      throw error;
    }
  }

  return {
    text: stripReasoningSummary(combinedText),
    toolsUsed: allToolsUsed,
  };
}

export function clearConversation(sessionKey: string): void {
  conversationHistory.delete(sessionKey);
  chatSessionIds.delete(sessionKey);
  chatUsageCache.delete(sessionKey);
}

export function setModel(chatId: number, model: string): void {
  chatModels.set(String(chatId), model);
  userPreferences.setModel(chatId, model);
}

export function getModel(chatId: number): string {
  // Check in-memory cache first, then persistence
  let model = chatModels.get(String(chatId));
  if (!model) {
    model = userPreferences.getModel(chatId);
    if (model) {
      chatModels.set(String(chatId), model);
    }
  }
  return model || 'opus';
}

export function clearModel(chatId: number): void {
  chatModels.delete(String(chatId));
  userPreferences.clearModel(chatId);
}

export function isDangerousMode(): boolean {
  return config.DANGEROUS_MODE;
}
