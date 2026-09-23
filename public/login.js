document.getElementById('login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const error = document.getElementById('error');
  error.classList.add('hidden');
  try {
    await api('POST', '/api/auth/login', {
      username: document.getElementById('username').value,
      password: document.getElementById('password').value,
    });
    const next = new URLSearchParams(location.search).get('next');
    // Only allow same-site relative redirects.
    location.href = next && /^\/(?!\/)/.test(next) ? next : '/staff';
  } catch (err) {
    error.textContent = err.message;
    error.classList.remove('hidden');
  }
});
