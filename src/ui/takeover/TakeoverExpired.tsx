export function TakeoverExpired() {
  return (
    <main class="expired-card">
      <h1>Takeover Session Not Active</h1>
      <p>
        This takeover link is no longer active. Ask the agent to request{' '}
        <code>browse_wait_for_user</code> again.
      </p>
      <p class="warn">
        If a session is currently active, use the latest link from chat.
      </p>
    </main>
  );
}
