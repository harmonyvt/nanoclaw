/**
 * Cancel detection for user-initiated interrupts.
 *
 * The host writes a cancel file to the IPC directory when the user sends /stop.
 * Agent-side code checks for this file to cooperatively abort long-running operations.
 */

import fs from 'fs';

const CANCEL_FILE = '/workspace/ipc/cancel';

export function isCancelled(): boolean {
  try { return fs.existsSync(CANCEL_FILE); } catch { return false; }
}

export function clearCancelFile(): void {
  try { fs.unlinkSync(CANCEL_FILE); } catch {}
}
