import { execSync } from 'child_process';

import {
  CUA_TAKEOVER_HTTPS_PORT,
  CUA_TAKEOVER_WEB_ENABLED,
  CUA_TAKEOVER_WEB_PORT,
  DASHBOARD_ENABLED,
  DASHBOARD_HTTPS_PORT,
  DASHBOARD_PORT,
  SANDBOX_TAILSCALE_ENABLED,
} from './config.js';
import { logger } from './logger.js';

interface PortMapping {
  localPort: number;
  httpsPort: number;
}

let cachedFqdn: string | null = null;
const activeMappings: PortMapping[] = [];

function getTailscaleFqdn(): string | null {
  if (cachedFqdn) return cachedFqdn;
  try {
    const raw = execSync('tailscale status --json', {
      stdio: 'pipe',
      timeout: 5000,
    }).toString();
    const status = JSON.parse(raw);
    const dnsName: string | undefined = status?.Self?.DNSName;
    if (!dnsName) return null;
    // DNSName has a trailing dot (e.g. "host.ts.net."), strip it
    cachedFqdn = dnsName.replace(/\.$/, '');
    return cachedFqdn;
  } catch {
    return null;
  }
}

function setupServe(localPort: number, httpsPort: number): boolean {
  try {
    execSync(
      `tailscale serve --bg --https=${httpsPort} http://localhost:${localPort}`,
      { stdio: 'pipe', timeout: 10000 },
    );
    activeMappings.push({ localPort, httpsPort });
    return true;
  } catch (err) {
    logger.warn(
      { module: 'tailscale', err, localPort, httpsPort },
      'Failed to configure tailscale serve',
    );
    return false;
  }
}

function removeServe(httpsPort: number): void {
  try {
    execSync(`tailscale serve --https=${httpsPort} off`, {
      stdio: 'pipe',
      timeout: 5000,
    });
  } catch {
    // May already be removed or tailscale not available
  }
}

export function getTailscaleHttpsUrl(localPort: number): string | null {
  const mapping = activeMappings.find((m) => m.localPort === localPort);
  if (!mapping || !cachedFqdn) return null;
  return `https://${cachedFqdn}:${mapping.httpsPort}`;
}

export function getTailscaleCachedFqdn(): string | null {
  return cachedFqdn;
}

export function isTailscaleServeActive(): boolean {
  return activeMappings.length > 0;
}

export function initTailscaleServe(): void {
  if (!SANDBOX_TAILSCALE_ENABLED) {
    logger.info({ module: 'tailscale' }, 'Tailscale serve disabled (SANDBOX_TAILSCALE_ENABLED=false)');
    return;
  }

  const fqdn = getTailscaleFqdn();
  if (!fqdn) {
    logger.warn(
      { module: 'tailscale' },
      'Could not detect Tailscale FQDN, skipping tailscale serve setup',
    );
    return;
  }

  logger.info({ module: 'tailscale', fqdn }, 'Tailscale FQDN detected');

  if (DASHBOARD_ENABLED) {
    if (setupServe(DASHBOARD_PORT, DASHBOARD_HTTPS_PORT)) {
      logger.info(
        { module: 'tailscale', url: `https://${fqdn}:${DASHBOARD_HTTPS_PORT}` },
        'Tailscale serve configured for dashboard',
      );
    }
  }

  if (CUA_TAKEOVER_WEB_ENABLED) {
    if (setupServe(CUA_TAKEOVER_WEB_PORT, CUA_TAKEOVER_HTTPS_PORT)) {
      logger.info(
        { module: 'tailscale', url: `https://${fqdn}:${CUA_TAKEOVER_HTTPS_PORT}` },
        'Tailscale serve configured for CUA takeover',
      );
    }
  }
}

export function stopTailscaleServe(): void {
  for (const mapping of activeMappings) {
    removeServe(mapping.httpsPort);
    logger.info(
      { module: 'tailscale', httpsPort: mapping.httpsPort },
      'Tailscale serve mapping removed',
    );
  }
  activeMappings.length = 0;
}
