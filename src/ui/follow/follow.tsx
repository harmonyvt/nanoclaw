import { render } from 'preact';
import { setAuthToken } from '../shared/api.js';
import { FollowApp } from './FollowApp.js';

// Initialize auth from URL params
const params = new URLSearchParams(window.location.search);
const session = params.get('session');
if (session) {
  setAuthToken(session);
  // Strip token from URL to prevent leaking in browser history
  const clean = new URL(window.location.href);
  clean.searchParams.delete('session');
  history.replaceState(null, '', clean.pathname + (clean.search || ''));
}

render(<FollowApp />, document.getElementById('app')!);
