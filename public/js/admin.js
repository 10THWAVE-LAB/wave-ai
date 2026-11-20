// WAVE AI — admin dashboard: stats, payment approvals, users, settings.
(function () {
  init();

  async function init() {
    // Only the admin account (ADMIN_EMAIL) may use this page.
    try {
      const me = (await api('/api/me')).user;
      if (!me.is_admin) {
        showError('This page is for the site owner only. Set ADMIN_EMAIL to your email and log in with that account.');
        return;
      }
    } catch {
      window.location.href = '/login?next=/admin';
      return;
    }

    document.getElementById('logout-link').addEventListener('click', async (e) => {
      e.preventDefault();
      await api('/api/auth/logout', { method: 'POST' });
      window.location.href = '/';
    });

    await Promise.all([loadStats(), loadPayments(), loadUsers(), loadSettings()]);
    wireSettingsForm();
  }

  function showError(msg) {
    const box = document.getElementById('admin-error');
    box.textContent = msg;
    box.classList.add('show');
  }

  function fmtDate(s) {
    if (!s) return '—';
    return new Date(s.replace(' ', 'T') + 'Z').toLocaleString();
  }

  async function loadStats() {
    const s = await api('/api/admin/stats');
    document.getElementById('stat-users').textContent = s.total_users;
    document.getElementById('stat-pro').textContent = s.pro_users;
    document.getElementById('stat-messages').textContent = s.messages_today;
    document.getElementById('stat-pending').textContent = s.pending_payments;
  }

  async function loadPayments() {
    const data = await api('/api/admin/payments');
    const body = document.getElementById('payments-body');
    body.innerHTML = '';
    if (!data.payments.length) {
      body.innerHTML = '<tr><td colspan="6" style="color:var(--muted)">No payments yet.</td></tr>';
      return;
    }
    data.payments.forEach((p) => {
      const tr = document.createElement('tr');
      const actions = document.createElement('td');
      if (p.status === 'pending') {
        const ok = document.createElement('button');
        ok.className = 'btn btn-sm';
        ok.textContent = 'Approve';
        ok.addEventListener('click', () => reviewPayment(p.id, 'approve'));
        const no = document.createElement('button');
        no.className = 'btn-ghost btn-sm btn-danger';
        no.textContent = 'Reject';
        no.style.marginLeft = '6px';
        no.addEventListener('click', () => reviewPayment(p.id, 'reject'));
        actions.append(ok, no);
      } else {
        actions.textContent = '—';
      }
      tr.innerHTML =
        `<td>${escapeHtml(fmtDate(p.created_at))}</td>` +
        `<td>${escapeHtml(p.email)}</td>` +
        `<td>${escapeHtml(p.ref_number)}</td>` +
        `<td>₱${escapeHtml(String(p.amount))}</td>` +
        `<td><span class="status-pill status-${p.status}">${p.status}</span></td>`;
      tr.appendChild(actions);
      body.appendChild(tr);
    });
  }

  async function reviewPayment(id, action) {
    const verb = action === 'approve' ? 'approve this payment and grant 30 days of Pro' : 'reject this payment';
    if (!window.confirm(`Are you sure you want to ${verb}?`)) return;
    await api(`/api/admin/payments/${id}/${action}`, { method: 'POST', body: '{}' });
    toast(action === 'approve' ? 'Payment approved — Pro granted for 30 days.' : 'Payment rejected.');
    await Promise.all([loadStats(), loadPayments(), loadUsers()]);
  }

  async function loadUsers() {
    const data = await api('/api/admin/users');
    const body = document.getElementById('users-body');
    body.innerHTML = '';
    if (!data.users.length) {
      body.innerHTML = '<tr><td colspan="4" style="color:var(--muted)">No users yet.</td></tr>';
      return;
    }
    data.users.forEach((u) => {
      const tr = document.createElement('tr');
      const proUntil = u.plan === 'pro' ? fmtDate(u.pro_until) : '—';
      tr.innerHTML =
        `<td>${escapeHtml(u.email)}</td>` +
        `<td>${u.plan === 'pro' ? '<span class="pro-pill">PRO</span>' : 'free'}</td>` +
        `<td>${escapeHtml(proUntil)}</td>` +
        `<td>${escapeHtml(fmtDate(u.created_at))}</td>`;
      body.appendChild(tr);
    });
  }

  async function loadSettings() {
    const s = await api('/api/admin/settings');
    document.getElementById('set-gcash-number').value = s.gcash_number || '';
    document.getElementById('set-gcash-name').value = s.gcash_name || '';
    document.getElementById('set-pro-price').value = s.pro_price_php;
    document.getElementById('set-free-limit').value = s.free_daily_limit;
    document.getElementById('set-stripe-link').value = s.stripe_payment_link || '';
  }

  function wireSettingsForm() {
    const form = document.getElementById('settings-form');
    const submit = document.getElementById('settings-submit');
    const successBox = document.getElementById('settings-success');
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      successBox.classList.remove('show');
      submit.disabled = true;
      submit.textContent = 'Saving…';
      try {
        await api('/api/admin/settings', {
          method: 'PUT',
          body: JSON.stringify({
            gcash_number: document.getElementById('set-gcash-number').value.trim(),
            gcash_name: document.getElementById('set-gcash-name').value.trim(),
            pro_price_php: Number(document.getElementById('set-pro-price').value),
            free_daily_limit: Number(document.getElementById('set-free-limit').value),
            stripe_payment_link: document.getElementById('set-stripe-link').value.trim(),
          }),
        });
        successBox.textContent = 'Settings saved.';
        successBox.classList.add('show');
      } catch (err) {
        showError(err.message);
      } finally {
        submit.disabled = false;
        submit.textContent = 'Save settings';
      }
    });
  }
})();
