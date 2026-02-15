import { InlineKeyboard } from 'grammy';
import { queryLogs, type LogEntry } from './db.js';
import { SERVICE_MODULES, SERVICE_NAMES } from './service-log-writer.js';

const PINO_LEVELS: Record<number, string> = {
  10: 'TRACE',
  20: 'DEBUG',
  30: 'INFO',
  40: 'WARN',
  50: 'ERROR',
  60: 'FATAL',
};

export const SERVICE_ICONS: Record<string, string> = {
  container: '\u{1F4E6}',    // package
  telegram: '\u{1F4AC}',     // speech balloon
  tts: '\u{1F50A}',          // speaker
  browse: '\u{1F310}',       // globe
  sandbox: '\u{1F5A5}',      // desktop
  media: '\u{1F3A4}',        // microphone
  scheduler: '\u{23F0}',     // alarm clock
  supermemory: '\u{1F9E0}',  // brain
  agent: '\u{1F916}',        // robot
  replicate: '\u{2699}\u{FE0F}',     // gear
  dashboard: '\u{1F4CA}',    // bar chart
};

export function buildDebugOverview(): string {
  return '<b>Debug Log Viewer</b>\n\nSelect a service to view its recent logs:';
}

export function buildDebugServiceKeyboard(): InlineKeyboard {
  const kb = new InlineKeyboard();
  const names = SERVICE_NAMES;

  for (let i = 0; i < names.length; i += 2) {
    const s1 = names[i];
    const icon1 = SERVICE_ICONS[s1] || '';
    kb.text(`${icon1} ${s1}`, `d:svc:${s1}`);
    if (i + 1 < names.length) {
      const s2 = names[i + 1];
      const icon2 = SERVICE_ICONS[s2] || '';
      kb.text(`${icon2} ${s2}`, `d:svc:${s2}`);
    }
    kb.row();
  }

  kb.text('\u{1F4CB} Export Full Report', 'd:export');
  return kb;
}

function levelLabel(level: number): string {
  return PINO_LEVELS[level] || `L${level}`;
}

export function formatLogLine(entry: LogEntry): string {
  const date = new Date(entry.time);
  const hh = String(date.getHours()).padStart(2, '0');
  const mm = String(date.getMinutes()).padStart(2, '0');
  const ss = String(date.getSeconds()).padStart(2, '0');
  const lvl = levelLabel(entry.level);
  const msg = entry.msg.replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return `${hh}:${mm}:${ss} [${lvl}] ${msg}`;
}

const MAX_MESSAGE_LENGTH = 4000; // Telegram limit is 4096, leave margin
const LOGS_PER_PAGE = 20;

export function buildServiceLogView(
  service: string,
  opts?: { minLevel?: number; page?: number },
): { text: string; keyboard: InlineKeyboard } {
  const modules = SERVICE_MODULES[service];
  if (!modules) {
    return {
      text: `Unknown service: ${service}`,
      keyboard: new InlineKeyboard().text('\u{2B05} Back', 'd:back'),
    };
  }

  const page = opts?.page || 0;
  const offset = page * LOGS_PER_PAGE;

  const entries = queryLogs({
    modules,
    minLevel: opts?.minLevel,
    limit: LOGS_PER_PAGE + 1, // fetch one extra to check if there are more
    offset,
  });

  const hasMore = entries.length > LOGS_PER_PAGE;
  const displayEntries = entries.slice(0, LOGS_PER_PAGE);

  const icon = SERVICE_ICONS[service] || '';
  const filterLabel =
    opts?.minLevel === 50 ? ' (errors)' : opts?.minLevel === 40 ? ' (warn+)' : '';
  let text = `${icon} <b>${service}</b>${filterLabel}\n\n`;

  if (displayEntries.length === 0) {
    text += '<i>No log entries found.</i>';
  } else {
    // Logs come back newest-first from queryLogs, reverse for chronological display
    const lines = displayEntries.reverse().map(formatLogLine);
    for (const line of lines) {
      if (text.length + line.length + 2 > MAX_MESSAGE_LENGTH) {
        text += '\n<i>... truncated</i>';
        break;
      }
      text += `<code>${line}</code>\n`;
    }
  }

  const kb = new InlineKeyboard();

  // Filter buttons
  if (!opts?.minLevel) {
    kb.text('\u{26A0} Warn+', `d:wrn:${service}`);
    kb.text('\u{274C} Errors', `d:err:${service}`);
  } else {
    kb.text('\u{1F4D6} All levels', `d:svc:${service}`);
    if (opts.minLevel === 40) {
      kb.text('\u{274C} Errors', `d:err:${service}`);
    } else {
      kb.text('\u{26A0} Warn+', `d:wrn:${service}`);
    }
  }
  kb.row();

  // Pagination
  if (page > 0 || hasMore) {
    if (page > 0) {
      const prevSuffix = opts?.minLevel === 50 ? `:err` : opts?.minLevel === 40 ? `:wrn` : '';
      kb.text('\u{2B05} Newer', `d:pg:${service}:${page - 1}${prevSuffix}`);
    }
    if (hasMore) {
      const nextSuffix = opts?.minLevel === 50 ? `:err` : opts?.minLevel === 40 ? `:wrn` : '';
      kb.text('Older \u{27A1}', `d:pg:${service}:${page + 1}${nextSuffix}`);
    }
    kb.row();
  }

  kb.text('\u{2B05} Back', 'd:back');

  return { text, keyboard: kb };
}
