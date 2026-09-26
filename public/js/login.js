(() => {
  const form = document.querySelector('#login-form');
  const error = document.querySelector('#login-error');
  const submit = document.querySelector('#login-submit');
  const next = new URLSearchParams(location.search).get('next');
  const destination = next && ['dashboard', 'upload', 'reports', 'universal', 'products', 'statuses', 'history', 'settings'].includes(next.split(/[?#]/, 1)[0].slice(1)) ? next : '/dashboard';

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    error.hidden = true;
    submit.disabled = true;
    submit.textContent = 'Logging in…';
    try {
      const response = await fetch('/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: form.elements.username.value, password: form.elements.password.value }) });
      if (!response.ok) throw new Error('Invalid username or password.');
      location.assign(destination);
    } catch {
      error.textContent = 'Invalid username or password.';
      error.hidden = false;
      form.elements.password.focus();
    } finally {
      submit.disabled = false;
      submit.textContent = 'Login';
    }
  });
})();
