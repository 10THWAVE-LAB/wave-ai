// WAVE AI — small shared helpers for all pages.
async function api(path, options = {}) {
  const res = await fetch(path, {
    credentials: 'include',
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
    ...options,
  });
  let data = {};
  try { data = await res.json(); } catch { /* non-JSON response */ }
  if (!res.ok) {
    const err = new Error(data.error || data.message || `Request failed (${res.status})`);
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

let toastTimer = null;
function toast(msg) {
  let el = document.querySelector('.toast');
  if (!el) {
    el = document.createElement('div');
    el.className = 'toast';
    document.body.appendChild(el);
  }
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 2600);
}

// Render Markdown safely: marked + DOMPurify when available,
// otherwise escaped plain text with line breaks.
function renderMarkdown(text) {
  if (window.marked && window.DOMPurify) {
    return window.DOMPurify.sanitize(window.marked.parse(text));
  }
  return escapeHtml(text).replace(/\n/g, '<br>');
}

// Add "Copy" buttons to code blocks inside an element.
function addCopyButtons(root) {
  root.querySelectorAll('pre').forEach((pre) => {
    if (pre.querySelector('.copy-btn')) return;
    const btn = document.createElement('button');
    btn.className = 'copy-btn';
    btn.textContent = 'Copy';
    btn.addEventListener('click', async () => {
      const code = pre.querySelector('code')?.textContent || pre.textContent;
      try {
        await navigator.clipboard.writeText(code);
        btn.textContent = 'Copied!';
      } catch {
        btn.textContent = 'Select & copy';
      }
      setTimeout(() => (btn.textContent = 'Copy'), 1500);
    });
    pre.appendChild(btn);
  });
}
