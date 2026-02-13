import type { HostRpcEvent, HostRpcRequest } from './container-runner.js';

type JsonObject = Record<string, unknown>;

export interface HostRpcRouterDeps {
  mainGroupFolder: string;
  groupFolderForChatJid: (chatJid: string) => string | undefined;
  sendMessage: (chatJid: string, text: string, sourceGroup: string) => Promise<void>;
  sendVoice: (
    payload: { chatJid: string; text: string; emotion?: string | null },
    sourceGroup: string,
  ) => Promise<string>;
  sendFile: (
    payload: { chatJid: string; filePath: string; caption?: string | null },
    sourceGroup: string,
  ) => Promise<string>;
  handleTaskAction: (
    payload: JsonObject,
    sourceGroup: string,
    isMain: boolean,
  ) => Promise<string>;
  handleBrowseAction: (
    sourceGroup: string,
    action: string,
    params: JsonObject,
  ) => Promise<JsonObject>;
  processStatusEvents: (
    sourceGroup: string,
    events: JsonObject[],
  ) => Promise<void>;
}

function asRecord(value: unknown): JsonObject {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as JsonObject;
  }
  return {};
}

function requireString(value: unknown, fieldName: string, method: string): string {
  if (typeof value === 'string' && value.length > 0) {
    return value;
  }
  throw new Error(`${method} missing ${fieldName}`);
}

function isAuthorizedTarget(
  sourceGroup: string,
  chatJid: string,
  deps: Pick<HostRpcRouterDeps, 'mainGroupFolder' | 'groupFolderForChatJid'>,
): boolean {
  if (sourceGroup === deps.mainGroupFolder) return true;
  return deps.groupFolderForChatJid(chatJid) === sourceGroup;
}

export async function routeHostRpcRequest(
  sourceGroup: string,
  req: HostRpcRequest,
  deps: HostRpcRouterDeps,
): Promise<unknown> {
  switch (req.method) {
    case 'telegram.sendMessage': {
      const payload = asRecord(req.params);
      const chatJid = requireString(payload.chatJid, 'chatJid/text', req.method);
      const text = requireString(payload.text, 'chatJid/text', req.method);
      if (!isAuthorizedTarget(sourceGroup, chatJid, deps)) {
        throw new Error('Unauthorized message send attempt');
      }
      await deps.sendMessage(chatJid, text, sourceGroup);
      return { ok: true, message: 'Message sent.' };
    }

    case 'telegram.sendVoice': {
      const payload = asRecord(req.params);
      const chatJid = requireString(payload.chatJid, 'chatJid/text', req.method);
      const text = requireString(payload.text, 'chatJid/text', req.method);
      if (!isAuthorizedTarget(sourceGroup, chatJid, deps)) {
        throw new Error('Unauthorized voice send attempt');
      }
      const emotion =
        typeof payload.emotion === 'string' ? payload.emotion : null;
      const message = await deps.sendVoice({ chatJid, text, emotion }, sourceGroup);
      return { ok: true, message };
    }

    case 'telegram.sendFile': {
      const payload = asRecord(req.params);
      const chatJid = requireString(payload.chatJid, 'chatJid/filePath', req.method);
      const filePath = requireString(payload.filePath, 'chatJid/filePath', req.method);
      if (!isAuthorizedTarget(sourceGroup, chatJid, deps)) {
        throw new Error('Unauthorized file send attempt');
      }
      const caption =
        typeof payload.caption === 'string' ? payload.caption : null;
      const message = await deps.sendFile({ chatJid, filePath, caption }, sourceGroup);
      return { ok: true, message };
    }

    case 'tasks.handle': {
      const payload = asRecord(req.params);
      const isMain = sourceGroup === deps.mainGroupFolder;
      const message = await deps.handleTaskAction(payload, sourceGroup, isMain);
      return { ok: true, message };
    }

    case 'browse.handle': {
      const payload = asRecord(req.params);
      const action = requireString(payload.action, 'action', req.method);
      const params = asRecord(payload.params);
      return await deps.handleBrowseAction(sourceGroup, action, params);
    }

    default:
      throw new Error(`Unknown host RPC method: ${req.method}`);
  }
}

export async function routeHostRpcEvent(
  sourceGroup: string,
  evt: HostRpcEvent,
  deps: Pick<HostRpcRouterDeps, 'processStatusEvents'>,
): Promise<void> {
  if (evt.method !== 'status.event') return;

  const payload = evt.params;
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return;
  }

  await deps.processStatusEvents(sourceGroup, [payload as JsonObject]);
}
