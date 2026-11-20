// WAVE AI — login / signup page. Mode comes from the URL path.
(function () {
  const isSignup = window.location.pathname === '/signup';
  const title = document.getElementById('auth-title');
  const sub = document.getElementById('auth-sub');
  const submit = document.getElementById('auth-submit');
  const switchEl = document.getElementById('auth-switch');
  const errorBox = document.getElementById('auth-error');
  const form = document.getElementById('auth-form');

  if (isSignup) {
    document.title = 'Sign up — WAVE AI';
    title.textContent = 'Create your account';
    sub.textContent = 'Free forever plan — 20 AI messages every day.';
    submit.textContent = 'Sign up free';
    document.getElementById('password').autocomplete = 'new-password';
    switchEl.innerHTML = 'Already have an account? <a href="/login">Log in</a>';
  }

  function showError(msg) {
    errorBox.textContent = msg;
    errorBox.classList.add('show');
  }

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    errorBox.classList.remove('show');
    submit.disabled = true;
    submit.textContent = isSignup ? 'Creating account…' : 'Logging in…';
    try {
      await api(isSignup ? '/api/auth/signup' : '/api/auth/login', {
        method: 'POST',
        body: JSON.stringify({
          email: document.getElementById('email').value.trim(),
          password: document.getElementById('password').value,
        }),
      });
      const next = new URLSearchParams(window.location.search).get('next') || '/app';
      window.location.href = next;
    } catch (err) {
      showError(err.message);
      submit.disabled = false;
      submit.textContent = isSignup ? 'Sign up free' : 'Log in';
    }
  });
})();
