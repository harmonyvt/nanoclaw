/**
 * Effect Schema definitions for scheduled tasks.
 * Wire-compatible with v1 ScheduledTask/TaskRunLog from src/types.ts.
 */

import { Schema } from 'effect';

export const ScheduledTask = Schema.Struct({
  id: Schema.String,
  group_folder: Schema.String,
  chat_jid: Schema.String,
  prompt: Schema.String,
  schedule_type: Schema.Literal('cron', 'interval', 'once'),
  schedule_value: Schema.String,
  context_mode: Schema.Literal('group', 'isolated'),
  next_run: Schema.NullOr(Schema.String),
  last_run: Schema.NullOr(Schema.String),
  last_result: Schema.NullOr(Schema.String),
  status: Schema.Literal('active', 'paused', 'completed'),
  created_at: Schema.String,
});
export type ScheduledTask = typeof ScheduledTask.Type;

export const TaskRunLog = Schema.Struct({
  task_id: Schema.String,
  run_at: Schema.String,
  duration_ms: Schema.Number,
  status: Schema.Literal('success', 'error'),
  result: Schema.NullOr(Schema.String),
  error: Schema.NullOr(Schema.String),
});
export type TaskRunLog = typeof TaskRunLog.Type;
