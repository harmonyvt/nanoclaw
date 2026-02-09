import { render } from 'preact';
import { setAuthToken } from '../shared/api.js';
import { FollowApp } from './FollowApp.js';

// Initialize auth from URL params
const params = new URLSearchParams(window.location.search);
const session = params.get('session');
if (session) {
  setAuthToken(session);
}

render(<FollowApp />, document.getElementById('app')!);
