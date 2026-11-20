// WAVE AI — chat app.
// Loads the conversation list, streams AI replies over SSE, enforces the
// free-plan counter shown in the sidebar (limits are enforced server-side).
(function () {
  const convoListEl = document.getElementById('convo-list');
  const messagesEl = document.getElementById('messages');
  const emptyStateEl = document.getElementById('empty-state');
  const inputEl = document.getElementById('composer-input');
  const sendBtn = document.getElementById('send-btn');
  const stopBtn = document.getElementById('stop-btn');
  const chatTitleEl = document.getElementById('chat-title');
  const sidebarEl = document.getElementById('sidebar');
  const limitBanner = document.getElementById('limit-banner');

  let me = null;
  let conversations = [];
  let currentId = null;
  let streaming = false;
  let abortCtrl = null;

  // ------------------------------------------------------------ bootstrap
  init();

  async function init() {
    try {
      const data = await api('/api/me');
      me = data.user;
    } catch {
      window.location.href = '/login?next=/app';
      return;
    }
    renderUser();
    await loadConversations();
    wireEvents();
    inputEl.focus();
  }

  function wireEvents() {
    document.getElementById('new-chat-btn').addEventListener('click', startNewChat);
    document.getElementById('menu-btn').addEventListener('click', () => sidebarEl.classList.toggle('open'));
    document.getElementById('logout-link').addEventListener('click', async (e) => {
      e.preventDefault();
      await api('/api/auth/logout', { method: 'POST' });
      window.location.href = '/';
    });
    sendBtn.addEventListener('click', sendMessage);
    stopBtn.addEventListener('click', () => abortCtrl && abortCtrl.abort());
    inputEl.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        sendMessage();
      }
    });
    inputEl.addEventListener('input', () => {
      inputEl.style.height = 'auto';
      inputEl.style.height = Math.min(inputEl.scrollHeight, 160) + 'px';
    });
    document.querySelectorAll('.suggestion').forEach((btn) => {
      btn.addEventListener('click', () => {
        inputEl.value = btn.dataset.prompt;
        inputEl.dispatchEvent(new Event('input'));
        sendMessage();
      });
    });
  }

  // ------------------------------------------------------------- user bar
  function renderUser() {
    document.getElementById('user-email').textContent = me.email;
    const pill = document.getElementById('plan-pill');
    const label = document.getElementById('usage-label');
    const count = document.getElementById('usage-count');
    const fill = document.getElementById('usage-fill');
    if (me.plan === 'pro') {
      pill.innerHTML = '<span class="pro-pill">PRO</span>';
      label.textContent = 'Unlimited messages';
      count.textContent = '∞';
      fill.style.width = '100%';
    } else {
      pill.textContent = '';
      label.textContent = 'Free messages today';
      count.textContent = `${me.messages_remaining} / ${me.messages_limit}`;
      const pct = me.messages_limit
        ? (me.messages_remaining / me.messages_limit) * 100
        : 0;
      fill.style.width = pct + '%';
    }
    if (me.is_admin) {
      const adminLink = document.getElementById('admin-link');
      adminLink.style.display = 'inline';
      adminLink.href = '/admin';
    }
  }

  async function refreshMe() {
    try {
      const data = await api('/api/me');
      me = data.user;
      renderUser();
    } catch { /* keep the old state */ }
  }

  // -------------------------------------------------------- conversations
  async function loadConversations() {
    const data = await api('/api/conversations');
    conversations = data.conversations;
    renderConvoList();
  }

  function renderConvoList() {
    convoListEl.innerHTML = '';
    if (conversations.length === 0) {
      convoListEl.innerHTML =
        '<p style="color:var(--muted);font-size:13.5px;padding:10px 12px">No chats yet — start a new one!</p>';
      return;
    }
    conversations.forEach((c) => {
      const item = document.createElement('div');
      item.className = 'convo-item' + (c.id === currentId ? ' active' : '');
      const title = document.createElement('span');
      title.className = 'title';
      title.textContent = c.title;
      const actions = document.createElement('span');
      actions.className = 'actions';
      const renameBtn = document.createElement('button');
      renameBtn.className = 'icon-btn';
      renameBtn.textContent = '✎';
      renameBtn.title = 'Rename';
      renameBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        renameConversation(c);
      });
      const delBtn = document.createElement('button');
      delBtn.className = 'icon-btn';
      delBtn.textContent = '🗑';
      delBtn.title = 'Delete';
      delBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        deleteConversation(c);
      });
      actions.append(renameBtn, delBtn);
      item.append(title, actions);
      item.addEventListener('click', () => selectConversation(c.id));
      convoListEl.appendChild(item);
    });
  }

  async function renameConversation(c) {
    const next = window.prompt('Rename chat:', c.title);
    if (next === null) return;
    const title = next.trim();
    if (!title) return;
    await api(`/api/conversations/${c.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ title }),
    });
    await loadConversations();
    if (c.id === currentId) chatTitleEl.textContent = title;
  }

  async function deleteConversation(c) {
    if (!window.confirm(`Delete "${c.title}"? This can't be undone.`)) return;
    await api(`/api/conversations/${c.id}`, { method: 'DELETE' });
    if (c.id === currentId) startNewChat();
    await loadConversations();
  }

  function startNewChat() {
    currentId = null;
    chatTitleEl.textContent = 'WAVE AI';
    messagesEl.innerHTML = '';
    messagesEl.appendChild(emptyStateEl);
    emptyStateEl.style.display = '';
    limitBanner.style.display = 'none';
    sidebarEl.classList.remove('open');
    renderConvoList();
    inputEl.focus();
  }

  async function selectConversation(id) {
    if (streaming) return;
    currentId = id;
    renderConvoList();
    sidebarEl.classList.remove('open');
    const data = await api(`/api/conversations/${id}`);
    chatTitleEl.textContent = data.conversation.title;
    messagesEl.innerHTML = '';
    data.messages.forEach((m) => appendMessage(m.role, m.content, true));
    messagesEl.scrollTop = messagesEl.scrollHeight;
  }

  // ------------------------------------------------------------- messages
  function appendMessage(role, content, rendered) {
    const wrap = document.createElement('div');
    wrap.className = `msg-wrap ${role}`;
    const avatar = document.createElement('div');
    avatar.className = 'avatar';
    avatar.textContent = role === 'assistant' ? '🌊' : '🧑';
    const msg = document.createElement('div');
    msg.className = 'msg';
    if (rendered) {
      msg.innerHTML = renderMarkdown(content);
      addCopyButtons(msg);
    } else {
      msg.textContent = content;
    }
    wrap.append(avatar, msg);
    messagesEl.appendChild(wrap);
    return msg;
  }

  function scrollToBottom() {
    messagesEl.scrollTop = messagesEl.scrollHeight;
  }

  function showLimitBanner(text) {
    limitBanner.innerHTML = `${escapeHtml(text)} <a href="/pricing">Upgrade to Pro →</a>`;
    limitBanner.style.display = 'block';
  }

  async function sendMessage() {
    const text = inputEl.value.trim();
    if (!text || streaming) return;
    limitBanner.style.display = 'none';
    emptyStateEl.style.display = 'none';

    // Create the conversation lazily on the first message.
    if (!currentId) {
      try {
        const data = await api('/api/conversations', { method: 'POST', body: '{}' });
        currentId = data.conversation.id;
        await loadConversations();
      } catch (err) {
        toast('Could not start a chat: ' + err.message);
        return;
      }
    }

    appendMessage('user', text, false);
    inputEl.value = '';
    inputEl.style.height = 'auto';
    scrollToBottom();

    streaming = true;
    sendBtn.style.display = 'none';
    stopBtn.style.display = 'block';
    inputEl.disabled = true;

    // Assistant bubble: "thinking" until the first token arrives.
    const assistantEl = appendMessage('assistant', '', false);
    assistantEl.innerHTML = '<span class="thinking">WAVE is thinking…</span>';
    scrollToBottom();

    abortCtrl = new AbortController();
    let fullText = '';
    let gotToken = false;
    try {
      const res = await fetch(`/api/conversations/${currentId}/messages`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: text }),
        signal: abortCtrl.signal,
      });

      if (!res.ok) {
        let errData = {};
        try { errData = await res.json(); } catch { /* ignore */ }
        assistantEl.remove();
        if (res.status === 402 || errData.error === 'limit_reached') {
          showLimitBanner(errData.message || 'You reached your free daily limit.');
          await refreshMe();
        } else {
          toast(errData.error || 'Something went wrong. Please try again.');
        }
        return;
      }

      // Read the SSE stream.
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let idx;
        while ((idx = buffer.indexOf('\n\n')) !== -1) {
          const chunk = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 2);
          for (const line of chunk.split('\n')) {
            const t = line.trim();
            if (!t.startsWith('data:')) continue;
            let payload;
            try { payload = JSON.parse(t.slice(5)); } catch { continue; }
            if (payload.token) {
              if (!gotToken) {
                gotToken = true;
                assistantEl.innerHTML = '';
              }
              fullText += payload.token;
              // Plain text while streaming (fast); Markdown on completion.
              assistantEl.textContent = fullText;
              const cursor = document.createElement('span');
              cursor.className = 'cursor';
              assistantEl.appendChild(cursor);
              scrollToBottom();
            } else if (payload.error) {
              assistantEl.innerHTML = `<span class="thinking">${escapeHtml(payload.error)}</span>`;
            }
          }
        }
      }
    } catch (err) {
      if (err.name === 'AbortError') {
        // User hit Stop — keep whatever partial reply arrived.
      } else {
        console.error(err);
        if (!gotToken) assistantEl.innerHTML = '<span class="thinking">AI is busy right now — please try again in a moment.</span>';
      }
    } finally {
      streaming = false;
      sendBtn.style.display = 'flex';
      stopBtn.style.display = 'none';
      inputEl.disabled = false;
      inputEl.focus();
      if (gotToken) {
        assistantEl.innerHTML = renderMarkdown(fullText);
        addCopyButtons(assistantEl);
        scrollToBottom();
      }
      await refreshMe();
      await loadConversations(); // refresh titles (auto-title on first message)
    }
  }
})();
