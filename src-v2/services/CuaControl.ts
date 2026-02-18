/**
 * CuaControl service — command-level interface to the CUA /cmd API.
 */

import { Context, Effect } from 'effect';
import type { BrowseError } from '../errors.js';

export interface CuaCommandAttempt {
  readonly command: string;
  readonly args?: Record<string, unknown>;
}

export interface CuaControlService {
  readonly command: (
    command: string,
    args?: Record<string, unknown>,
  ) => Effect.Effect<unknown, BrowseError>;

  readonly commandWithFallback: (
    attempts: ReadonlyArray<CuaCommandAttempt>,
  ) => Effect.Effect<unknown, BrowseError>;

  readonly isKnownCommand: (command: string) => boolean;
  readonly shellSingleQuote: (value: string) => string;
}

export class CuaControl extends Context.Tag('CuaControl')<
  CuaControl,
  CuaControlService
>() {}
