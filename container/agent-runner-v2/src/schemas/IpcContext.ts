/**
 * Effect Schema for IPC authorization context.
 */

import { Schema } from 'effect';

export const IpcMcpContext = Schema.Struct({
  chatJid: Schema.String,
  groupFolder: Schema.String,
  isMain: Schema.Boolean,
});
export type IpcMcpContext = typeof IpcMcpContext.Type;
