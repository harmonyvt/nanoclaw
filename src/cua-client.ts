import type { paths } from './generated/cua-openapi.generated.js';
import { CUA_COMMAND_CATALOG } from './generated/cua-commands.generated.js';

type CmdRequestBody = paths['/cmd']['post']['requestBody'] extends {
  content: { 'application/json': infer T };
}
  ? T
  : Record<string, unknown>;

export class CuaClient {
  private readonly baseUrl: string;
  private readonly headers: Record<string, string>;

  constructor(baseUrl: string, headers?: Record<string, string>) {
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.headers = headers || {};
  }

  static fromCommandUrl(
    commandUrl: string,
    headers?: Record<string, string>,
  ): CuaClient {
    return new CuaClient(commandUrl.replace(/\/cmd\/?$/, ''), headers);
  }

  async status(): Promise<unknown> {
    return this.requestJson('/status', { method: 'GET' });
  }

  async listCommands(): Promise<unknown> {
    return this.requestJson('/commands', { method: 'GET' });
  }

  async commandRaw(
    command: string,
    params: Record<string, unknown> = {},
  ): Promise<Response> {
    const resolvedCommand = CuaClient.resolveCommandName(command);
    const normalizedParams = CuaClient.normalizeParams(
      resolvedCommand,
      params,
    );
    const body = {
      command: resolvedCommand,
      params: normalizedParams,
      // Backward compatibility for older server schema versions.
      args: normalizedParams,
    } as CmdRequestBody & Record<string, unknown>;

    return fetch(`${this.baseUrl}/cmd`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...this.headers,
      },
      body: JSON.stringify(body),
    });
  }

  isKnownCommand(command: string): boolean {
    return CuaClient.isKnownCommandName(command);
  }

  static isKnownCommandName(command: string): boolean {
    return (
      Object.prototype.hasOwnProperty.call(
        CUA_COMMAND_CATALOG.commands || {},
        command,
      ) ||
      Object.prototype.hasOwnProperty.call(
        CUA_COMMAND_CATALOG.aliases || {},
        command,
      )
    );
  }

  static resolveCommandName(command: string): string {
    const aliasMap = CUA_COMMAND_CATALOG.aliases || {};
    const mapped = aliasMap[command as keyof typeof aliasMap];
    if (typeof mapped === 'string' && mapped) {
      return mapped;
    }
    return command;
  }

  private static normalizeParams(
    command: string,
    params: Record<string, unknown>,
  ): Record<string, unknown> {
    const normalized: Record<string, unknown> = { ...params };

    switch (command) {
      case 'open': {
        if (normalized.target === undefined) {
          const target = normalized.target ?? normalized.url ?? normalized.uri;
          if (typeof target === 'string' && target.trim()) {
            normalized.target = target;
          }
        }
        break;
      }
      case 'run_command': {
        if (
          normalized.command === undefined &&
          typeof normalized.cmd === 'string' &&
          normalized.cmd.trim()
        ) {
          normalized.command = normalized.cmd;
        }
        break;
      }
      case 'find_element': {
        if (normalized.title === undefined) {
          const titleCandidate =
            normalized.title ??
            normalized.description ??
            normalized.query ??
            normalized.selector;
          if (
            typeof titleCandidate === 'string' &&
            titleCandidate.trim()
          ) {
            normalized.title = titleCandidate;
          }
        }
        break;
      }
      case 'scroll': {
        if (normalized.x === undefined) {
          const mappedX =
            normalized.x ??
            normalized.delta_x ??
            normalized.deltaX ??
            normalized.dx;
          normalized.x = typeof mappedX === 'number' ? mappedX : 0;
        }
        if (normalized.y === undefined) {
          const mappedY =
            normalized.y ??
            normalized.delta_y ??
            normalized.deltaY ??
            normalized.dy;
          normalized.y = typeof mappedY === 'number' ? mappedY : 0;
        }
        break;
      }
      default:
        break;
    }

    return CuaClient.pickKnownParams(command, normalized);
  }

  private static pickKnownParams(
    command: string,
    params: Record<string, unknown>,
  ): Record<string, unknown> {
    const commands = CUA_COMMAND_CATALOG.commands || {};
    const definition = commands[command as keyof typeof commands];
    const paramDefs = definition?.params || [];
    const names = paramDefs
      .map((entry) => entry?.name)
      .filter((name) => typeof name === 'string' && name.length > 0) as string[];

    if (names.length === 0) return params;

    const picked: Record<string, unknown> = {};
    for (const name of names) {
      if (Object.prototype.hasOwnProperty.call(params, name)) {
        picked[name] = params[name];
      }
    }

    // If nothing matched, keep original params for forward compatibility.
    return Object.keys(picked).length > 0 ? picked : params;
  }

  private async requestJson(pathname: string, init: RequestInit): Promise<unknown> {
    const response = await fetch(`${this.baseUrl}${pathname}`, {
      ...init,
      headers: { ...this.headers, ...(init.headers || {}) },
    });
    if (!response.ok) {
      const body = await response.text();
      throw new Error(
        `CUA request failed (${response.status}) for ${pathname}: ${body.slice(0, 500)}`,
      );
    }
    return response.json();
  }
}
