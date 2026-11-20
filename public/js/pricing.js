// WAVE AI — pricing page: shows plans, GCash details, payment submission.
(function () {
  init();

  async function init() {
    const settings = await api('/api/public-settings');
    document.getElementById('pro-price').textContent = '₱' + settings.pro_price_php;
    document.getElementById('free-limit-text').textContent =
      settings.free_daily_limit + ' AI messages per day';
    document.getElementById('gcash-amount').textContent = '₱' + settings.pro_price_php;
    document.getElementById('pay-amount').value = settings.pro_price_php;
    document.getElementById('gcash-number').textContent =
      settings.gcash_number || '09XX-XXX-XXXX — set in Admin';
    document.getElementById('gcash-name').textContent =
      settings.gcash_name || 'GCash number not configured yet';
    if (settings.stripe_payment_link) {
      document.getElementById('stripe-box').style.display = 'block';
      document.getElementById('stripe-btn').href = settings.stripe_payment_link;
    }

    // Who is viewing? Logged-out users get a login button instead of the form.
    let me = null;
    try {
      me = (await api('/api/me')).user;
    } catch { /* not logged in */ }

    if (!me) {
      document.getElementById('gcash-box').style.display = 'none';
      document.getElementById('stripe-box').style.display = 'none';
      document.getElementById('login-needed').style.display = 'block';
      return;
    }

    if (me.plan === 'pro') {
      const until = me.pro_until
        ? new Date(me.pro_until.replace(' ', 'T') + 'Z').toLocaleDateString()
        : '';
      document.getElementById('pro-status').innerHTML =
        `<div class="success-box show">You're on <strong>Pro</strong>${until ? ' until ' + until : ''}. Enjoy unlimited chats! 🌊</div>`;
      document.getElementById('gcash-box').style.display = 'none';
      document.getElementById('stripe-box').style.display = 'none';
    }

    await loadMyPayments();
    wireForm();
  }

  async function loadMyPayments() {
    try {
      const data = await api('/api/payments/mine');
      if (!data.payments.length) return;
      document.getElementById('my-payments').style.display = 'block';
      const body = document.getElementById('payments-body');
      body.innerHTML = '';
      data.payments.forEach((p) => {
        const tr = document.createElement('tr');
        const date = new Date(p.created_at.replace(' ', 'T') + 'Z').toLocaleString();
        tr.innerHTML =
          `<td>${escapeHtml(date)}</td>` +
          `<td>${escapeHtml(p.ref_number)}</td>` +
          `<td>₱${escapeHtml(String(p.amount))}</td>` +
          `<td><span class="status-pill status-${p.status}">${p.status}</span></td>`;
        body.appendChild(tr);
      });
    } catch { /* payments table is a nice-to-have */ }
  }

  function wireForm() {
    const form = document.getElementById('gcash-form');
    const errorBox = document.getElementById('pay-error');
    const successBox = document.getElementById('pay-success');
    const submit = document.getElementById('gcash-submit');
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      errorBox.classList.remove('show');
      successBox.classList.remove('show');
      submit.disabled = true;
      submit.textContent = 'Submitting…';
      try {
        await api('/api/payments/gcash', {
          method: 'POST',
          body: JSON.stringify({
            ref_number: document.getElementById('ref-number').value.trim(),
            amount: Number(document.getElementById('pay-amount').value),
          }),
        });
        successBox.textContent = 'Payment submitted! Your Pro will be activated once verified — usually within a few hours.';
        successBox.classList.add('show');
        form.reset();
        document.getElementById('pay-amount').value =
          document.getElementById('gcash-amount').textContent.replace('₱', '');
        await loadMyPayments();
      } catch (err) {
        errorBox.textContent = err.message;
        errorBox.classList.add('show');
      } finally {
        submit.disabled = false;
        submit.textContent = "I've paid — activate Pro";
      }
    });
  }
})();
