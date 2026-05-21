

const toggleBtn = document.getElementById('toggle-password');
const passwordInput = document.getElementById('password');
if (toggleBtn && passwordInput) {
    toggleBtn.addEventListener('click', () => {
        const hidden = passwordInput.type === 'password';
        passwordInput.type = hidden ? 'text' : 'password';
        toggleBtn.textContent = hidden ? 'HIDE' : 'SHOW';
    });
}

const showError = (id, msg) => {
    const el = document.getElementById(id);
    if (!el) return;
    el.textContent = msg;
    el.classList.add('show');
    el.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
};

const hideError = (id) => {
    const el = document.getElementById(id);
    if (el) el.classList.remove('show');
};

const loginForm = document.getElementById('login-form');

if (loginForm) {
    loginForm.addEventListener('submit', async function (e) {
        e.preventDefault();
        hideError('login-error');

        const email = document.getElementById('email').value.trim();
        const password = document.getElementById('password').value;
        const btn = document.getElementById('login-btn');

        if (!email) return showError('login-error', 'Please enter your email address.');
        if (!password) return showError('login-error', 'Please enter your password.');

        const origText = btn.textContent;
        btn.disabled = true;
        btn.innerHTML = '<span class="spinner"></span> Signing in...';

        const result = await api.post('/auth/login', { email, password }, false);

        btn.disabled = false;
        btn.textContent = origText;

        if (result && result.success) {
            const payload = result.data || result;
            saveSession(payload.token, payload.user);
            showToast(`Welcome back, ${payload.user.full_name}!`, 'success');

            setTimeout(() => {
                const role = payload.user.role;
                if (role === 'admin' || role === 'owner') goTo('admin-dashboard.html');
                else if (role === 'barber') goTo('barber-dashboard.html');
                else if (role === 'staff') goTo('staff-dashboard.html');
                else showError('login-error', `Unknown role "${role}". Contact your administrator.`);
            }, 600);
        } else {
            showError('login-error', result?.message || 'Login failed. Please try again.');
        }
    });
}
redirectIfLoggedIn();