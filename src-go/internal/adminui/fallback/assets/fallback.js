(async () => {
  const target = document.createElement('pre');
  target.style.fontSize = '12px';
  target.style.color = '#5d667d';
  target.style.whiteSpace = 'pre-wrap';
  try {
    const res = await fetch('/admin/config.json');
    const cfg = await res.json();
    target.textContent = `Runtime config:\n${JSON.stringify(cfg, null, 2)}`;
  } catch {
    target.textContent = 'Runtime config is unavailable.';
  }
  document.querySelector('.wrap')?.appendChild(target);
})();
