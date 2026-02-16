/**
 * Adapter types — defines the ProviderAdapter interface using Effect Stream.
 */

import { Stream } from 'effect';
import type { AgentEvent } from '../schemas/AgentEvent.js';
import type { AdapterError } from '../errors/index.js';
import type { HostBridge } from '../services/HostBridge.js';
import type { ToolRegistry } from '../services/ToolRegistry.js';
import type { Cancellation } from '../services/Cancellation.js';

export interface AdapterInput {
  readonly prompt: string;
  readonly model?: string;
  readonly baseUrl?: string;
  readonly groupFolder: string;
  readonly isMain: boolean;
  readonly isScheduledTask?: boolean;
  readonly assistantName?: string;
  readonly enableThinking?: boolean;
  readonly ipcContext: {
    readonly chatJid: string;
    readonly groupFolder: string;
    readonly isMain: boolean;
  };
}

/** All provider adapters implement this interface */
export interface ProviderAdapter {
  readonly run: (
    input: AdapterInput,
  ) => Stream.Stream<
    AgentEvent,
    AdapterError,
    HostBridge | ToolRegistry | Cancellation
  >;
}
