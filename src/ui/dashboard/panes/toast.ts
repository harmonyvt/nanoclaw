/**
 * Simple DOM-based toast notification.
 * Appends a toast element, removes after 2.5s.
 */
export function showToast(message: string, type: 'ok' | 'error' = 'ok'): void {
  const el = document.createElement('div');
  el.className = 'toast';
  el.textContent = message;
  el.style.cssText = [
    'position: fixed',
    'bottom: 80px',
    'left: 50%',
    'transform: translateX(-50%)',
    'padding: 10px 20px',
    'border-radius: 10px',
    'font-size: 13px',
    'font-weight: 500',
    'z-index: 300',
    'pointer-events: none',
    'animation: toastIn 200ms ease-out',
    `background: ${type === 'error' ? 'rgba(239,68,68,0.9)' : 'rgba(56,189,248,0.9)'}`,
    'color: #fff',
  ].join(';');

  document.body.appendChild(el);

  setTimeout(() => {
    el.style.opacity = '0';
    el.style.transition = 'opacity 200ms';
    setTimeout(() => el.remove(), 200);
  }, 2500);
}
