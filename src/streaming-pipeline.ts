/**
 * StreamingMessagePipeline — owns the entire Telegram message lifecycle
 * for a single agent run. One instance per processMessage() invocation.
 *
 * Replaces the 3 global Maps (activeStatusMessages, activeStreamingMessages,
 * activeCuaLogMessages), the 170-line processStatusEvents() function, and
 * the voiceSentDuringRun Set from src/index.ts.
 */

import { logger } from './logger.js';
import { logDebugEvent } from './debug-log.js';

// ─── Types ───────────────────────────────────────────────────────────────────

export interface PipelineEvent {
  type: 'thinking' | 'response_delta' | 'tool_start' | 'tool_progress' | 'adapter_stderr';
  content?: string;
  message?: string;
  tool_name?: string;
  preview?: string;
  elapsed_seconds?: number;
}

export interface TelegramOps {
  sendStatusMessage(chatJid: string, text: string): Promise<number | null>;
  editStatusMessage(chatJid: string, messageId: number, text: string): Promise<boolean>;
  sendMessageWithId(chatJid: string, text: string): Promise<number | null>;
  editMessageText(chatJid: string, messageId: number, text: string): Promise<boolean>;
  deleteMessage(chatJid: string, messageId: number): Promise<void>;
  sendMessage(chatJid: string, text: string): Promise<void>;
  sendPhoto(chatJid: string, path: string, caption?: string): Promise<number | null>;
  editPhoto(chatJid: string, messageId: number, path: string, caption?: string): Promise<boolean>;
}

export interface PipelineConfig {
  chatJid: string;
  groupFolder: string;
  thinkingEnabled: boolean;
  verboseEnabled: boolean;
}

type Phase = 'idle' | 'thinking' | 'tool_active' | 'responding' | 'done';

// ─── Constants ───────────────────────────────────────────────────────────────

/** Minimum interval between Telegram message edits (ms) */
const STATUS_EDIT_INTERVAL_MS = 2500;

/** Max chars in a single Telegram message (accounting for <i></i> tags) */
const MAX_CHUNK = 4000;

/** Tool names that shouldn't appear as status (agent sending its reply) */
const HIDDEN_TOOLS = new Set(['send_message', 'send_file', 'send_voice']);

export const TOOL_DISPLAY_NAMES: Record<string, string> = {
  // Claude SDK built-in tools
  Bash: 'running command', Read: 'reading file', Write: 'writing file',
  Edit: 'editing file', Glob: 'searching files', Grep: 'searching code',
  WebSearch: 'searching the web', WebFetch: 'fetching page',
  // Browser tools
  browse_navigate: 'browsing', browse_snapshot: 'reading page',
  browse_click: 'clicking', browse_click_xy: 'clicking',
  browse_fill: 'filling form', browse_type_at_xy: 'typing',
  browse_perform: 'performing actions', browse_screenshot: 'taking screenshot',
  browse_wait_for_user: 'waiting for you', browse_go_back: 'going back',
  browse_close: 'closing browser', browse_extract_file: 'extracting file',
  browse_upload_file: 'uploading file', browse_evaluate: 'running script',
  // Firecrawl
  firecrawl_scrape: 'scraping page', firecrawl_crawl: 'crawling site',
  firecrawl_map: 'mapping URLs',
  // Memory
  memory_save: 'saving to memory', memory_search: 'searching memory',
  // Tasks
  schedule_task: 'scheduling task', list_tasks: 'checking tasks',
  pause_task: 'pausing task', resume_task: 'resuming task',
  cancel_task: 'cancelling task', register_group: 'registering group',
};

export function humanizeToolName(rawName: string): string {
  const name = rawName.replace(/^mcp__nanoclaw__/, '');
  return TOOL_DISPLAY_NAMES[name] || name.replace(/_/g, ' ');
}

// ─── Pipeline ────────────────────────────────────────────────────────────────

export class StreamingMessagePipeline {
  private phase: Phase = 'idle';
  private statusMessageId: number | null = null;
  private statusExtraIds: number[] = [];
  private streamingMessageId: number | null = null;
  private cuaTextMessageId: number | null = null;
  private cuaScreenshotMessageId: number | null = null;
  private cuaLastText = '';
  private toolHistory: string[] = [];
  private voiceSent = false;
  private hadThinkingContent = false;
  private lastStatusText = '';
  private lastStatusEditTime = 0;
  private lastStreamingText = '';
  private lastStreamingEditTime = 0;

  constructor(
    private readonly config: PipelineConfig,
    private readonly telegram: TelegramOps,
  ) {}

  // ─── Lifecycle ─────────────────────────────────────────────────────────────

  /** Send initial thinking status message. */
  async start(): Promise<void> {
    if (!this.config.thinkingEnabled) {
      this.phase = 'thinking';
      return;
    }
    const msgId = await this.telegram.sendStatusMessage(
      this.config.chatJid,
      'thinking',
    );
    if (msgId) {
      this.statusMessageId = msgId;
      this.lastStatusText = 'thinking';
      this.lastStatusEditTime = Date.now();
    }
    this.phase = 'thinking';
  }

  /** Process a status event from the agent container. */
  async handleEvent(event: PipelineEvent): Promise<void> {
    // Always log adapter_stderr to Pino and debug events
    if (event.type === 'adapter_stderr') {
      logger.warn(
        { module: 'claude-cli', group_folder: this.config.groupFolder },
        `[stderr] ${event.message}`,
      );
      logDebugEvent('sdk', 'adapter_log', this.config.groupFolder, {
        message: String(event.message),
      });
    }

    if (event.type === 'tool_start') {
      logDebugEvent('sdk', 'tool_call', this.config.groupFolder, {
        toolName: event.tool_name,
        preview: String(event.preview || '').slice(0, 200),
      });
    }

    // Update status message (thinking content or tool activity)
    if (this.statusMessageId !== null) {
      if (event.type === 'thinking' && event.content) {
        this.hadThinkingContent = true;
        this.phase = 'thinking';
        await this.updateStatusMessage(event.content);
      } else if (event.type === 'tool_start') {
        const toolName = String(event.tool_name || '').replace(/^mcp__nanoclaw__/, '');
        if (!HIDDEN_TOOLS.has(toolName)) {
          const displayName = humanizeToolName(String(event.tool_name));
          this.toolHistory.push(displayName);
          this.phase = 'tool_active';
          await this.updateStatusMessage(this.buildToolStatusText());
        }
      }
    }

    // Update streaming response message
    if (event.type === 'response_delta') {
      this.phase = 'responding';
      await this.updateStreamingMessage(String(event.content));
    }

    // Verbose mode: send full detail messages
    if (this.config.verboseEnabled) {
      if (event.type === 'tool_start') {
        const preview = event.preview ? String(event.preview).slice(0, 100) : '';
        const line = `> ${event.tool_name}${preview ? ': ' + preview : ''}`;
        try {
          await this.telegram.sendMessage(this.config.chatJid, line);
        } catch {
          // Verbose messages are best-effort
        }
      } else if (event.type === 'tool_progress') {
        const line = `> ${event.tool_name} (${event.elapsed_seconds}s)`;
        try {
          await this.telegram.sendMessage(this.config.chatJid, line);
        } catch {
          // Verbose messages are best-effort
        }
      }
    }
  }

  /** Process multiple events (batch). */
  async handleEvents(events: PipelineEvent[]): Promise<void> {
    for (const event of events) {
      await this.handleEvent(event);
    }
  }

  /** Update CUA status text in-place. */
  async handleCuaStatus(text: string): Promise<void> {
    if (text === this.cuaLastText) return;

    if (this.cuaTextMessageId !== null) {
      const edited = await this.telegram.editMessageText(
        this.config.chatJid,
        this.cuaTextMessageId,
        text,
      );
      if (edited) {
        this.cuaLastText = text;
        return;
      }
      // Edit failed (message deleted?), fall through to send new
    }

    const msgId = await this.telegram.sendMessageWithId(this.config.chatJid, text);
    if (msgId) {
      this.cuaTextMessageId = msgId;
      this.cuaLastText = text;
    }
  }

  /** Update CUA screenshot in-place. */
  async handleCuaScreenshot(hostPath: string): Promise<void> {
    if (this.cuaScreenshotMessageId !== null) {
      const edited = await this.telegram.editPhoto(
        this.config.chatJid,
        this.cuaScreenshotMessageId,
        hostPath,
        'Screenshot',
      );
      if (edited) {
        logDebugEvent('telegram', 'screenshot_edited', this.config.groupFolder, {
          chatId: this.config.chatJid,
          messageId: this.cuaScreenshotMessageId,
        });
        return;
      }
      // Edit failed — clear stale ID and fall through to send new
      logDebugEvent('telegram', 'screenshot_edit_failed', this.config.groupFolder, {
        chatId: this.config.chatJid,
        messageId: this.cuaScreenshotMessageId,
      });
      this.cuaScreenshotMessageId = null;
    }

    try {
      const msgId = await this.telegram.sendPhoto(
        this.config.chatJid,
        hostPath,
        'Screenshot',
      );
      if (msgId) {
        this.cuaScreenshotMessageId = msgId;
      }
    } catch (err) {
      logDebugEvent('telegram', 'screenshot_send_failed', this.config.groupFolder, {
        chatId: this.config.chatJid,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /**
   * Clean up all transient messages after the agent run completes.
   * - Deletes the streaming response message (replaced by final delivery)
   * - Keeps thinking status if it had real reasoning content
   * - Deletes CUA log messages
   */
  async finish(): Promise<void> {
    this.phase = 'done';

    // Clean up streaming message
    if (this.streamingMessageId !== null) {
      await this.telegram.deleteMessage(this.config.chatJid, this.streamingMessageId);
      this.streamingMessageId = null;
    }

    // Clean up thinking status message(s)
    if (this.statusMessageId !== null) {
      if (this.hadThinkingContent && this.config.thinkingEnabled) {
        // Keep reasoning visible — don't delete
      } else {
        await this.telegram.deleteMessage(this.config.chatJid, this.statusMessageId);
        for (const extraId of this.statusExtraIds) {
          await this.telegram.deleteMessage(this.config.chatJid, extraId);
        }
      }
      this.statusMessageId = null;
      this.statusExtraIds = [];
    }

    // Clean up CUA log messages
    if (this.cuaTextMessageId !== null) {
      await this.telegram.deleteMessage(this.config.chatJid, this.cuaTextMessageId);
      this.cuaTextMessageId = null;
    }
    if (this.cuaScreenshotMessageId !== null) {
      await this.telegram.deleteMessage(this.config.chatJid, this.cuaScreenshotMessageId);
      this.cuaScreenshotMessageId = null;
    }
  }

  // ─── Voice Deduplication ───────────────────────────────────────────────────

  /** Mark that the agent sent voice during this run. */
  markVoiceSent(): void {
    this.voiceSent = true;
  }

  /** Consume the voice-sent flag (returns true if voice was sent, then resets). */
  consumeVoiceSent(): boolean {
    const sent = this.voiceSent;
    this.voiceSent = false;
    return sent;
  }

  // ─── Private Helpers ───────────────────────────────────────────────────────

  /** Build status text from tool history. Shows all tools, latest is active. */
  private buildToolStatusText(): string {
    return this.toolHistory.join('\n');
  }

  /** Update the status message with rate limiting and chunking. */
  private async updateStatusMessage(newText: string): Promise<void> {
    if (this.statusMessageId === null) return;
    if (newText === this.lastStatusText) return;

    const now = Date.now();
    if (now - this.lastStatusEditTime < STATUS_EDIT_INTERVAL_MS) return;

    // Delete any previous overflow messages
    for (const extraId of this.statusExtraIds) {
      await this.telegram.deleteMessage(this.config.chatJid, extraId);
    }
    this.statusExtraIds = [];

    // Split into chunks at line boundaries when possible
    const chunks = splitIntoChunks(newText, MAX_CHUNK);

    // Edit the primary message with the first chunk
    const edited = await this.telegram.editStatusMessage(
      this.config.chatJid,
      this.statusMessageId,
      chunks[0],
    );
    if (edited) {
      this.lastStatusText = newText;
      this.lastStatusEditTime = now;

      // Send overflow chunks as additional messages
      for (let i = 1; i < chunks.length; i++) {
        const extraId = await this.telegram.sendStatusMessage(
          this.config.chatJid,
          chunks[i],
        );
        if (extraId) {
          this.statusExtraIds.push(extraId);
        }
      }
    }
  }

  /** Update the streaming response message with rate limiting. */
  private async updateStreamingMessage(content: string): Promise<void> {
    if (!content) return;

    const now = Date.now();
    const truncated = content.length > MAX_CHUNK ? content.slice(-MAX_CHUNK) : content;

    if (this.streamingMessageId === null) {
      const msgId = await this.telegram.sendMessageWithId(
        this.config.chatJid,
        truncated,
      );
      if (msgId) {
        this.streamingMessageId = msgId;
        this.lastStreamingText = content;
        this.lastStreamingEditTime = now;
      }
    } else if (
      content !== this.lastStreamingText &&
      now - this.lastStreamingEditTime >= STATUS_EDIT_INTERVAL_MS
    ) {
      const edited = await this.telegram.editMessageText(
        this.config.chatJid,
        this.streamingMessageId,
        truncated,
      );
      if (edited) {
        this.lastStreamingText = content;
        this.lastStreamingEditTime = now;
      }
    }
  }
}

// ─── Utility ─────────────────────────────────────────────────────────────────

function splitIntoChunks(text: string, maxChunk: number): string[] {
  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > 0) {
    if (remaining.length <= maxChunk) {
      chunks.push(remaining);
      break;
    }
    let splitAt = remaining.lastIndexOf('\n', maxChunk);
    if (splitAt === -1) splitAt = maxChunk;
    chunks.push(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt).replace(/^\n/, '');
  }
  return chunks;
}
