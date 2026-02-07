import { chromium, type Browser, type Page } from 'playwright-core';
import fs from 'fs';
import path from 'path';
import { GROUPS_DIR } from './config.js';
import { logger } from './logger.js';
import { ensureSandbox, resetIdleTimer } from './sandbox-manager.js';

let browser: Browser | null = null;
let page: Page | null = null;

// Pending wait-for-user requests: requestId -> resolve function
const waitingForUser: Map<string, () => void> = new Map();

async function getPage(): Promise<Page> {
  if (page && !page.isClosed()) return page;

  const cdpUrl = await ensureSandbox();

  // Retry CDP connection with exponential backoff — sandbox needs time to boot Xvfb + Chromium
  const maxRetries = 10;
  const retryDelay = 2000;
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      browser = await chromium.connectOverCDP(cdpUrl);
      break;
    } catch (err) {
      if (attempt === maxRetries) {
        throw new Error(
          `Failed to connect to sandbox CDP after ${maxRetries} attempts: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      const delay = Math.min(retryDelay * Math.pow(1.5, attempt - 1), 10000);
      logger.info(
        { attempt, maxRetries, delay, err: err instanceof Error ? err.message : String(err) },
        'CDP connection failed, retrying',
      );
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }

  const contexts = browser!.contexts();
  const context = contexts[0] || (await browser!.newContext());
  const pages = context.pages();
  page = pages[0] || (await context.newPage());
  return page;
}

export async function processBrowseRequest(
  requestId: string,
  action: string,
  params: Record<string, unknown>,
  groupFolder: string,
  ipcDir: string,
): Promise<{ status: 'ok' | 'error'; result?: unknown; error?: string }> {
  resetIdleTimer();

  try {
    switch (action) {
      case 'navigate': {
        const p = await getPage();
        await p.goto(params.url as string, {
          waitUntil: 'domcontentloaded',
          timeout: 30000,
        });
        return { status: 'ok', result: await p.title() };
      }
      case 'snapshot': {
        const p = await getPage();
        const snapshot = await p.locator('body').ariaSnapshot();
        return { status: 'ok', result: snapshot };
      }
      case 'click': {
        const p = await getPage();
        await p.click(params.selector as string, { timeout: 10000 });
        return { status: 'ok', result: 'clicked' };
      }
      case 'fill': {
        const p = await getPage();
        await p.fill(params.selector as string, params.value as string, {
          timeout: 10000,
        });
        return { status: 'ok', result: 'filled' };
      }
      case 'screenshot': {
        const p = await getPage();
        const mediaDir = path.join(GROUPS_DIR, groupFolder, 'media');
        fs.mkdirSync(mediaDir, { recursive: true });
        const filename = `screenshot-${Date.now()}.png`;
        const filePath = path.join(mediaDir, filename);
        await p.screenshot({ path: filePath, fullPage: false });
        return { status: 'ok', result: `/workspace/group/media/${filename}` };
      }
      case 'wait_for_user': {
        return new Promise((resolve) => {
          waitingForUser.set(requestId, () => {
            resolve({ status: 'ok', result: 'User continued' });
          });
        });
      }
      case 'go_back': {
        const p = await getPage();
        await p.goBack({ timeout: 10000 });
        return { status: 'ok', result: await p.title() };
      }
      case 'evaluate': {
        const p = await getPage();
        const result = await p.evaluate(params.expression as string);
        return {
          status: 'ok',
          result:
            typeof result === 'string' ? result : JSON.stringify(result),
        };
      }
      case 'close': {
        if (page && !page.isClosed()) {
          await page.close();
          page = null;
        }
        if (browser) {
          await browser.close().catch(() => {});
          browser = null;
        }
        return { status: 'ok', result: 'closed' };
      }
      default:
        return { status: 'error', error: `Unknown action: ${action}` };
    }
  } catch (err) {
    logger.error({ err, action, requestId }, 'Browse request failed');
    return {
      status: 'error',
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

// Called when user sends "continue" in Telegram for a specific chat
export function resolveWaitForUser(requestId?: string): boolean {
  if (requestId && waitingForUser.has(requestId)) {
    waitingForUser.get(requestId)!();
    waitingForUser.delete(requestId);
    return true;
  }
  // If no specific ID, resolve the oldest waiting request
  const first = waitingForUser.entries().next();
  if (!first.done) {
    first.value[1]();
    waitingForUser.delete(first.value[0]);
    return true;
  }
  return false;
}

export function hasWaitingRequests(): boolean {
  return waitingForUser.size > 0;
}

export async function disconnectBrowser(): Promise<void> {
  if (page && !page.isClosed()) {
    await page.close().catch(() => {});
  }
  if (browser) {
    await browser.close().catch(() => {});
    browser = null;
    page = null;
  }
}
