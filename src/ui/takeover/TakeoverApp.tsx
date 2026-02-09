import type { TakeoverData } from '../shared/types.js';
import { TakeoverExpired } from './TakeoverExpired.js';
import { TakeoverActive } from './TakeoverActive.js';

declare global {
  interface Window {
    __TAKEOVER_DATA__?: TakeoverData;
  }
}

export function TakeoverApp() {
  const data = window.__TAKEOVER_DATA__;

  if (!data || data.status === 'expired') {
    return <TakeoverExpired />;
  }

  return <TakeoverActive data={data} />;
}
