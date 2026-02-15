/**
 * Effect service: Application Configuration
 *
 * Wraps the existing config.ts constants into an Effect service
 * that can be injected via Context/Layer.
 */
import { Context, Layer } from 'effect';

import {
  ASSISTANT_NAME,
  POLL_INTERVAL,
  SCHEDULER_POLL_INTERVAL,
  MAX_CONCURRENT_AGENTS,
  MAX_CONVERSATION_MESSAGES,
  CONTAINER_IMAGE,
  CONTAINER_TIMEOUT,
  CONTAINER_MAX_OUTPUT_SIZE,
  IPC_POLL_INTERVAL,
  MAX_AGENT_RETRIES,
  AGENT_RETRY_DELAY,
  MAIN_GROUP_FOLDER,
  GROUPS_DIR,
  DATA_DIR,
  STORE_DIR,
  SERVICE_LOGS_DIR,
  TIMEZONE,
  DEFAULT_PROVIDER,
  DEFAULT_MODEL,
  TELEGRAM_BOT_TOKEN,
  TELEGRAM_OWNER_ID,
  TRIGGER_PATTERN,
  SANDBOX_IDLE_TIMEOUT_MS,
  CUA_TAKEOVER_WEB_ENABLED,
  CUA_TAKEOVER_WEB_PORT,
  DASHBOARD_ENABLED,
  DASHBOARD_PORT,
  QWEN_TTS_ENABLED,
  QWEN_TTS_URL,
} from '../../config.js';

export interface AppConfig {
  readonly assistantName: string;
  readonly pollInterval: number;
  readonly schedulerPollInterval: number;
  readonly maxConcurrentAgents: number;
  readonly maxConversationMessages: number;
  readonly containerImage: string;
  readonly containerTimeout: number;
  readonly containerMaxOutputSize: number;
  readonly ipcPollInterval: number;
  readonly maxAgentRetries: number;
  readonly agentRetryDelay: number;
  readonly mainGroupFolder: string;
  readonly groupsDir: string;
  readonly dataDir: string;
  readonly storeDir: string;
  readonly serviceLogsDir: string;
  readonly timezone: string;
  readonly defaultProvider: string;
  readonly defaultModel: string;
  readonly telegramBotToken: string;
  readonly telegramOwnerId: string;
  readonly triggerPattern: RegExp;
  readonly sandboxIdleTimeoutMs: number;
  readonly cuaTakeoverWebEnabled: boolean;
  readonly cuaTakeoverWebPort: number;
  readonly dashboardEnabled: boolean;
  readonly dashboardPort: number;
  readonly qwenTtsEnabled: boolean;
  readonly qwenTtsUrl: string;
}

export class Config extends Context.Tag('nanoclaw/Config')<
  Config,
  AppConfig
>() {}

export const ConfigLive = Layer.succeed(Config, {
  assistantName: ASSISTANT_NAME,
  pollInterval: POLL_INTERVAL,
  schedulerPollInterval: SCHEDULER_POLL_INTERVAL,
  maxConcurrentAgents: MAX_CONCURRENT_AGENTS,
  maxConversationMessages: MAX_CONVERSATION_MESSAGES,
  containerImage: CONTAINER_IMAGE,
  containerTimeout: CONTAINER_TIMEOUT,
  containerMaxOutputSize: CONTAINER_MAX_OUTPUT_SIZE,
  ipcPollInterval: IPC_POLL_INTERVAL,
  maxAgentRetries: MAX_AGENT_RETRIES,
  agentRetryDelay: AGENT_RETRY_DELAY,
  mainGroupFolder: MAIN_GROUP_FOLDER,
  groupsDir: GROUPS_DIR,
  dataDir: DATA_DIR,
  storeDir: STORE_DIR,
  serviceLogsDir: SERVICE_LOGS_DIR,
  timezone: TIMEZONE,
  defaultProvider: DEFAULT_PROVIDER,
  defaultModel: DEFAULT_MODEL,
  telegramBotToken: TELEGRAM_BOT_TOKEN,
  telegramOwnerId: TELEGRAM_OWNER_ID,
  triggerPattern: TRIGGER_PATTERN,
  sandboxIdleTimeoutMs: SANDBOX_IDLE_TIMEOUT_MS,
  cuaTakeoverWebEnabled: CUA_TAKEOVER_WEB_ENABLED,
  cuaTakeoverWebPort: CUA_TAKEOVER_WEB_PORT,
  dashboardEnabled: DASHBOARD_ENABLED,
  dashboardPort: DASHBOARD_PORT,
  qwenTtsEnabled: QWEN_TTS_ENABLED,
  qwenTtsUrl: QWEN_TTS_URL,
} satisfies AppConfig);
