export function TakeoverExpired() {
  return (
    <div class="takeover-wrap">
      <main class="takeover-card">
        <div class="card-body expired-card">
          <div class="expired-icon">
            <svg viewBox="0 0 24 24">
              <circle cx="12" cy="12" r="10" />
              <line x1="15" y1="9" x2="9" y2="15" />
              <line x1="9" y1="9" x2="15" y2="15" />
            </svg>
          </div>
          <h1>Session Not Active</h1>
          <p>
            This takeover link is no longer active. Ask the agent to request{' '}
            <code>browse_wait_for_user</code> again.
          </p>
          <p class="warn">
            If a session is currently active, use the latest link from chat.
          </p>
        </div>
      </main>
    </div>
  );
}
