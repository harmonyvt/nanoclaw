import type { TakeoverData } from '../shared/types.js';
import { MetadataPanel } from './MetadataPanel.js';

interface Props {
  data: TakeoverData;
}

export function TakeoverActive({ data }: Props) {
  return (
    <div class="takeover-wrap">
      <main class="takeover-card">
        <MetadataPanel
          requestId={data.requestId!}
          groupFolder={data.groupFolder!}
          createdAt={data.createdAt!}
          token={data.token!}
          session={data.session || ''}
          message={data.message}
          liveViewUrl={data.liveViewUrl}
          vncPassword={data.vncPassword}
        />
      </main>

      <div class="bottom-badges">
        <span class="bottom-badge">
          <svg viewBox="0 0 24 24"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" /><path d="m9 12 2 2 4-4" /></svg>
          End-to-End Encrypted
        </span>
        <span class="bottom-badge">
          <svg viewBox="0 0 24 24"><path d="M13 2 3 14h9l-1 8 10-12h-9l1-8z" /></svg>
          Low Latency Stream
        </span>
      </div>
    </div>
  );
}
