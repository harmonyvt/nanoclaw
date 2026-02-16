/**
 * Tool registry — collects all tool modules.
 */

import type { NanoTool } from './types.js';
import { communicationTools } from './communication.js';
import { audioTools } from './audio.js';
import { taskTools } from './tasks.js';
import { groupTools } from './groups.js';
import { skillTools } from './skills.js';
import { browseTools } from './browse.js';
import { firecrawlTools } from './firecrawl.js';
import { memoryTools } from './memory.js';
import { filesystemTools } from './filesystem.js';

export const ALL_TOOLS: ReadonlyArray<NanoTool> = [
  ...communicationTools,
  ...audioTools,
  ...taskTools,
  ...groupTools,
  ...skillTools,
  ...browseTools,
  ...firecrawlTools,
  ...memoryTools,
  ...filesystemTools,
];

export type { NanoTool } from './types.js';
