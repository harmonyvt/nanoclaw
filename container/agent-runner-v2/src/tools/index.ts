/**
 * Tool registry — collects all tool modules.
 * Tool modules will be imported here in Phase 2 when tools are decomposed.
 */

import type { NanoTool } from './types.js';

// Phase 2: import and spread tool arrays from each module
// import { communicationTools } from './communication.js';
// import { audioTools } from './audio.js';
// import { taskTools } from './tasks.js';
// import { groupTools } from './groups.js';
// import { skillTools } from './skills.js';
// import { browseTools } from './browse.js';
// import { firecrawlTools } from './firecrawl.js';
// import { memoryTools } from './memory.js';

export const ALL_TOOLS: ReadonlyArray<NanoTool> = [
  // ...communicationTools,
  // ...audioTools,
  // ...taskTools,
  // ...groupTools,
  // ...skillTools,
  // ...browseTools,
  // ...firecrawlTools,
  // ...memoryTools,
];
