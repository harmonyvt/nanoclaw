/**
 * Effect Schema for tool execution results.
 */

import { Schema } from 'effect';

export const ToolResult = Schema.Struct({
  content: Schema.String,
  isError: Schema.optional(Schema.Boolean),
  imageBase64: Schema.optional(Schema.String),
  imageMimeType: Schema.optional(Schema.String),
});
export type ToolResult = typeof ToolResult.Type;
