/**
 * Production layer composition — assembles all service Live layers.
 *
 * Phase 1: Stub layer with AppConfig only.
 * Services will be added as their Live implementations are built.
 */

import { Layer } from 'effect';
import { AppConfig, AppConfigLive } from '../config.js';

/**
 * MainLive — the full application layer.
 * Currently only includes AppConfig. Services will be merged in
 * as their Layer implementations are created in later phases.
 */
export const MainLive: Layer.Layer<AppConfig> = AppConfigLive;
