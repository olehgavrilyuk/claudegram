import {
  sendToAgent as claudeSendToAgent,
  sendLoopToAgent as claudeSendLoopToAgent,
  clearConversation as claudeClearConversation,
  setModel as claudeSetModel,
  getModel as claudeGetModel,
  clearModel as claudeClearModel,
  getCachedUsage as claudeGetCachedUsage,
  isDangerousMode as claudeIsDangerousMode,
} from '../claude/agent.js';
import type { Provider, AgentOptions, LoopOptions, AgentResponse, AgentUsage, ModelInfo } from './types.js';

const CLAUDE_MODELS: ModelInfo[] = [
  { id: 'opus', label: 'opus', description: 'Most capable' },
  { id: 'opus[1m]', label: 'opus (1M)', description: 'Opus with 1M-token context — for large/resumed sessions' },
  { id: 'sonnet', label: 'sonnet', description: 'Balanced' },
  { id: 'sonnet[1m]', label: 'sonnet (1M)', description: 'Sonnet with 1M-token context' },
  { id: 'haiku', label: 'haiku', description: 'Fast & light' },
];

export const claudeProvider: Provider = {
  name: 'claude',

  sendToAgent(sessionKey: string, message: string, options?: AgentOptions): Promise<AgentResponse> {
    return claudeSendToAgent(sessionKey, message, options);
  },

  sendLoopToAgent(sessionKey: string, message: string, options?: LoopOptions): Promise<AgentResponse> {
    return claudeSendLoopToAgent(sessionKey, message, options);
  },

  clearConversation(sessionKey: string): void {
    claudeClearConversation(sessionKey);
  },

  setModel(chatId: number, model: string): void {
    claudeSetModel(chatId, model);
  },

  getModel(chatId: number): string {
    return claudeGetModel(chatId);
  },

  clearModel(chatId: number): void {
    claudeClearModel(chatId);
  },

  getCachedUsage(sessionKey: string): AgentUsage | undefined {
    return claudeGetCachedUsage(sessionKey);
  },

  isDangerousMode(): boolean {
    return claudeIsDangerousMode();
  },

  async getAvailableModels(): Promise<ModelInfo[]> {
    return CLAUDE_MODELS;
  },
};
