import { render } from 'preact';
import { setAuthToken } from '../shared/api.js';
import { TakeoverApp } from './TakeoverApp.js';

// Initialize auth from the embedded data before rendering
const data = (window as any).__TAKEOVER_DATA__;
if (data?.session) {
  setAuthToken(data.session);
}

render(<TakeoverApp />, document.getElementById('app')!);
