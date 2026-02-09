import type { TakeoverData } from '../shared/types.js';
import { MetadataPanel } from './MetadataPanel.js';
import { DesktopViewer } from './DesktopViewer.js';

interface Props {
  data: TakeoverData;
}

export function TakeoverActive({ data }: Props) {
  const liveAvailable = !!data.liveViewUrl;
  const launchReady = !!data.liveViewUrl && !!data.vncPassword;

  return (
    <>
      <header>
        <h1 class="title">CUA Browser Takeover</h1>
        <p class="subtitle">
          {data.message ||
            'Use this page to control the CUA browser, then return control to the agent.'}
        </p>
      </header>

      <section class="shell">
        <MetadataPanel
          requestId={data.requestId!}
          groupFolder={data.groupFolder!}
          createdAt={data.createdAt!}
          token={data.token!}
          session={data.session || ''}
        />

        <main class="panel workspace">
          <div class="workspace-bar">
            <span>Live CUA Desktop</span>
            <span>{launchReady ? 'ready' : liveAvailable ? 'preparing' : 'unavailable'}</span>
          </div>
          <DesktopViewer
            liveViewUrl={data.liveViewUrl}
            vncPassword={data.vncPassword}
          />
        </main>
      </section>
    </>
  );
}
