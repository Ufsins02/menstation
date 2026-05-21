// ============================================================
// frontend/assets/js/barber.js  v3 - FINAL
// Barber Dashboard: Schedule - Commission - History - Profile
// NO sale creation. All data from /api/barber/* and /api/reservations
// Depends on api.js loaded first.
// ============================================================

requireAuth(['barber']);

// ─── State ────────────────────────────────────────────────────
let commissionChart = null;
let currentProfile = null;

// ─── Page metadata ────────────────────────────────────────────
const PAGE = {
    schedule: { title: 'My Schedule',        subtitle: 'Reservations assigned to you today' },
    earnings: { title: 'Commission Overview', subtitle: 'Daily and weekly earnings breakdown' },
    history:  { title: 'Service History',     subtitle: 'All completed services' },
    profile:  { title: 'My Profile',          subtitle: 'Account information' }
};

// ─── Bootstrap ────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
    initUserInfo();
    initTopbarDate();
    initNav();
    initSidebar();
    initChangePassword();
    initProfileForms();

    // Set default dates
    const today = getToday();
    const el = document.getElementById('schedule-date');
    if (el) el.value = today;

    const firstDay = today.slice(0, 8) + '01';
    const hf = document.getElementById('hist-from');
    const ht = document.getElementById('hist-to');
    if (hf) hf.value = firstDay;
    if (ht) ht.value = today;

    // Load initial page
    loadSchedule();
    loadStats(); // always fetch stats for the strip
});

// ─── User info ────────────────────────────────────────────────
function initUserInfo() {
    const user = getUser();
    if (!user) return;
    setEl('sidebar-name', user.full_name);
    setEl('sidebar-avatar', initials(user.full_name));
}

function initTopbarDate() {
    setEl('topbar-date', new Date().toLocaleDateString('en-PH', {
        weekday: 'short', month: 'short', day: 'numeric', year: 'numeric'
    }));
}

// ─── Navigation ───────────────────────────────────────────────
function initNav() {
    document.querySelectorAll('.nav-item[data-page]').forEach(item => {
        item.addEventListener('click', () => {
            showPage(item.dataset.page);
            if (window.innerWidth <= 900) closeSidebar();
        });
    });
}

function showPage(name) {
    // Update active nav
    document.querySelectorAll('.nav-item').forEach(i => i.classList.remove('active'));
    document.querySelector(`.nav-item[data-page="${name}"]`)?.classList.add('active');

    // Show correct section
    document.querySelectorAll('.page-section').forEach(s => s.classList.remove('active'));
    document.getElementById(`page-${name}`)?.classList.add('active');

    // Update topbar
    const meta = PAGE[name] || { title: name, subtitle: '' };
    setEl('page-title',    meta.title);
    setEl('page-subtitle', meta.subtitle);

    // Load data for this page
    switch (name) {
        case 'schedule': loadSchedule(); break;
        case 'earnings': loadEarnings(); break;
        case 'history':  /* user triggers filter */ break;
        case 'profile':  loadProfile();  break;
    }
}

// ─── Sidebar ──────────────────────────────────────────────────
function initSidebar() {
    document.getElementById('sidebar-toggle')
        ?.addEventListener('click', () => {
            document.getElementById('sidebar')?.classList.toggle('open');
            document.getElementById('sidebar-overlay')?.classList.toggle('open');
        });
    document.getElementById('sidebar-overlay')
        ?.addEventListener('click', closeSidebar);
}

function closeSidebar() {
    document.getElementById('sidebar')?.classList.remove('open');
    document.getElementById('sidebar-overlay')?.classList.remove('open');
}

// ─── Helpers ──────────────────────────────────────────────────
function setEl(id, val) {
    const el = document.getElementById(id);
    if (el) el.textContent = val;
}

function initials(name) {
    return (name || '?').split(' ').map(n => n[0]).join('').slice(0, 2).toUpperCase();
}

function statusBadge(status) {
    const map = {
        pending:     'badge-warning',
        confirmed:   'badge-info',
        in_progress: 'badge-olive',
        done:        'badge-success',
        cancelled:   'badge-danger'
    };
    return `<span class="badge ${map[status] || ''}">${(status || '').replace('_', ' ')}</span>`;
}

// ════════════════════════════════════════════════════════════
// STATS - fills the strip on the schedule page
// ════════════════════════════════════════════════════════════
async function loadStats() {
    const res = await api.get('/barber/stats');
    if (!res?.success) return;
    const s = res.stats;

    setEl('stat-today-res',  s.today_reservations ?? 0);
    setEl('stat-today-earn', formatPeso(s.today_earnings));
    setEl('stat-month-earn', formatPeso(s.monthly_earnings));
    setEl('stat-month-cust', s.monthly_customers);
}

// ════════════════════════════════════════════════════════════
// SCHEDULE - today's reservations for this barber
// ════════════════════════════════════════════════════════════
async function loadSchedule(dateOverride) {
    const dateInput = document.getElementById('schedule-date');
    const date = dateOverride || dateInput?.value || getToday();
    if (dateInput) dateInput.value = date;

    const lbl = document.getElementById('schedule-date-label');
    if (lbl) lbl.textContent = formatDate(date);

    const tbody = document.getElementById('schedule-tbody');
    if (!tbody) return;
    tbody.innerHTML = loading(5);

    // Fetch this barber's reservations for the selected date
    const res = await api.get(`/barber/reservations?date=${date}`);

    if (!res?.success) {
        tbody.innerHTML = errorRow('Failed to load schedule. Check your connection.', 5);
        return;
    }

    if (!res.data.length) {
        tbody.innerHTML = emptyState(`No reservations on ${formatDate(date)}.`, 5);
        return;
    }

    tbody.innerHTML = res.data.map(r => `
        <tr>
            <td style="font-family:monospace;font-weight:700;font-size:14px;">
                ${formatTime(r.res_time)}
            </td>
            <td>
                <div style="font-weight:600;">${r.customer_name}</div>
                ${r.customer_phone
                    ? `<div style="font-size:11px;color:var(--text-muted)">${r.customer_phone}</div>`
                    : ''}
            </td>
            <td>${r.service_name}</td>
            <td style="color:var(--text-muted)">${r.duration_min} min</td>
            <td>${statusBadge(r.status)}</td>
        </tr>`).join('');
}

// ════════════════════════════════════════════════════════════
// EARNINGS - commission chart + monthly breakdown
// ════════════════════════════════════════════════════════════
async function loadEarnings() {
    // Fetch stats + chart in parallel
    const [statsRes, chartRes] = await Promise.all([
        api.get('/barber/stats'),
        api.get('/barber/weekly-chart')
    ]);

    // ── Stats ────────────────────────────────────────────────
    if (statsRes?.success) {
        const s = statsRes.stats;
        setEl('earn-today',     formatPeso(s.today_earnings));
        setEl('earn-today-sub', `${s.today_customers} customers`);
        setEl('earn-month',     formatPeso(s.monthly_earnings));
        setEl('earn-month-sub', `${s.monthly_customers} customers`);
        setEl('earn-rate',      `${s.commission_rate}%`);
    }

    // ── Chart ────────────────────────────────────────────────
    if (chartRes?.success) {
        const data    = chartRes.data || [];
        const labels  = data.map(d => d.day || (d.sale_date || '').slice(-5));
        const amounts = data.map(d => parseFloat(d.earnings) || 0);

        const canvas = document.getElementById('commission-chart');
        if (canvas) {
            if (commissionChart) commissionChart.destroy();
            commissionChart = new Chart(canvas.getContext('2d'), {
                type: 'bar',
                data: {
                    labels,
                    datasets: [{
                        label: 'Daily Earnings',
                        data: amounts,
                        backgroundColor: 'rgba(93,115,80,0.7)',
                        borderColor: '#5d7350',
                        borderWidth: 1,
                        borderRadius: 3
                    }]
                },
                options: {
                    responsive: true,
                    maintainAspectRatio: false,
                    plugins: {
                        legend: { display: false },
                        tooltip: { callbacks: { label: c => ` ${formatPeso(c.parsed.y)}` } }
                    },
                    scales: {
                        x: { ticks: { color: '#9a9a9a' }, grid: { color: '#1e1e1e' } },
                        y: {
                            ticks: {
                                color: '#9a9a9a',
                                callback: v => '\u20B1' + v.toLocaleString()
                            },
                            grid: { color: '#1e1e1e' }
                        }
                    }
                }
            });
        }
    }

    // ── Monthly table ────────────────────────────────────────
    const today    = getToday();
    const firstDay = today.slice(0, 8) + '01';
    const salesRes = await api.get(`/barber/sales?date_from=${firstDay}&date_to=${today}`);

    const tbody = document.getElementById('earnings-tbody');
    if (!tbody) return;

    if (!salesRes?.success || !salesRes.data.length) {
        tbody.innerHTML = emptyState('No completed services this month yet.', 4);
        setEl('earn-total-rev', 'Total: ' + formatPeso(0));
        return;
    }

    const totalComm = salesRes.data.reduce((s, r) => s + parseFloat(r.commission_amount || 0), 0);
    setEl('earn-total-rev', 'Total commission: ' + formatPeso(totalComm));

    tbody.innerHTML = salesRes.data.map(s => `
        <tr>
            <td>${formatDate(s.sale_date)}</td>
            <td>${s.service_name}</td>
            <td style="color:var(--text-secondary)">${formatPeso(s.amount)}</td>
            <td style="font-weight:700;color:#5d7350">${formatPeso(s.commission_amount)}</td>
        </tr>`).join('') + `
        <tr style="background:var(--bg-elevated);">
            <td colspan="3" style="text-align:right;font-weight:600;padding:12px 14px;
                font-size:11px;color:var(--text-muted);text-transform:uppercase;
                letter-spacing:0.08em;">Total This Month</td>
            <td style="font-weight:700;color:#5d7350;font-size:15px;padding:12px 14px;">
                ${formatPeso(totalComm)}
            </td>
        </tr>`;
}

// ════════════════════════════════════════════════════════════
// HISTORY - filtered completed service log
// ════════════════════════════════════════════════════════════
async function loadHistory() {
    const dateFrom = document.getElementById('hist-from')?.value;
    const dateTo   = document.getElementById('hist-to')?.value;
    const tbody    = document.getElementById('history-tbody');
    if (!tbody) return;

    tbody.innerHTML = loading(5);

    let ep = '/barber/sales?';
    if (dateFrom) ep += `date_from=${dateFrom}&`;
    if (dateTo)   ep += `date_to=${dateTo}`;

    const res = await api.get(ep);

    if (!res?.success) {
        tbody.innerHTML = errorRow('Failed to load history.', 5);
        return;
    }

    if (!res.data.length) {
        tbody.innerHTML = emptyState('No service history found for this period.', 5);
        return;
    }

    const totalRev  = res.data.reduce((s, r) => s + parseFloat(r.amount || 0), 0);
    const totalComm = res.data.reduce((s, r) => s + parseFloat(r.commission_amount || 0), 0);

    tbody.innerHTML = res.data.map(s => `
        <tr>
            <td>${formatDate(s.sale_date)}</td>
            <td>${s.service_name}</td>
            <td style="color:var(--text-secondary)">${s.customer_name}</td>
            <td style="font-weight:600;color:var(--text-primary)">${formatPeso(s.amount)}</td>
            <td style="font-weight:700;color:#5d7350">${formatPeso(s.commission_amount)}</td>
        </tr>`).join('') + `
        <tr style="background:var(--bg-elevated);">
            <td colspan="3" style="text-align:right;font-weight:600;padding:12px 14px;
                font-size:11px;color:var(--text-muted);text-transform:uppercase;
                letter-spacing:0.08em;">Totals (${res.data.length} records)</td>
            <td style="font-weight:700;color:var(--text-primary);padding:12px 14px;">
                ${formatPeso(totalRev)}
            </td>
            <td style="font-weight:700;color:#5d7350;padding:12px 14px;">
                ${formatPeso(totalComm)}
            </td>
        </tr>`;
}

// ════════════════════════════════════════════════════════════
// PROFILE
// ════════════════════════════════════════════════════════════
async function loadProfile() {
    const res = await api.get('/barber/profile');
    if (!res?.success) {
        showToast('Failed to load profile.', 'error');
        return;
    }
    const p = res.data;
    currentProfile = p;
    const ini = initials(p.full_name);

    setEl('p-avatar',        ini);
    setEl('p-name',          p.full_name);
    setEl('p-email',         p.email);
    setEl('p-phone',         p.phone || 'Not set');
    setEl('p-branch',        p.branch_name || 'Not assigned');
    setEl('p-specialization',p.specialization || 'General');
    setEl('p-commission',    `${p.commission_rate}%`);
    setEl('p-member-since',  formatDate(p.created_at));
    setProfilePhoto(p.profile_photo);
    fillProfileForm(p);

    // Also update sidebar avatar
    setEl('sidebar-avatar', ini);
    setEl('sidebar-name',   p.full_name);
    await loadWorks(p.id);
}

function setProfilePhoto(src) {
    const preview = document.getElementById('p-photo-preview');
    const img = document.getElementById('p-photo');
    if (!preview || !img) return;

    if (src) {
        img.src = src;
        preview.classList.add('has-image');
    } else {
        img.removeAttribute('src');
        preview.classList.remove('has-image');
    }
}

function fillProfileForm(p) {
    const values = {
        'profile-full-name': p.full_name || '',
        'profile-nickname': p.nickname || '',
        'profile-specialization': p.specialization || '',
        'profile-bio': p.bio || '',
        'profile-photo-url': p.profile_photo || ''
    };
    Object.entries(values).forEach(([id, value]) => {
        const el = document.getElementById(id);
        if (el) el.value = value;
    });
}

function readImageFile(input) {
    const file = input?.files?.[0];
    if (!file) return Promise.resolve('');
    if (!file.type.startsWith('image/')) return Promise.reject(new Error('Please choose an image file.'));
    if (file.size > 2 * 1024 * 1024) return Promise.reject(new Error('Image file must be 2MB or smaller.'));

    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = () => reject(new Error('Unable to read image file.'));
        reader.readAsDataURL(file);
    });
}

function initProfileForms() {
    document.getElementById('profile-photo-file')?.addEventListener('change', async (e) => {
        try {
            const dataUrl = await readImageFile(e.target);
            if (dataUrl) {
                document.getElementById('profile-photo-url').value = dataUrl;
                setProfilePhoto(dataUrl);
            }
        } catch (err) {
            showToast(err.message, 'error');
            e.target.value = '';
        }
    });

    document.getElementById('profile-form')?.addEventListener('submit', async (e) => {
        e.preventDefault();
        const btn = document.getElementById('btn-save-profile');
        btn.disabled = true;
        btn.textContent = 'Saving...';

        const payload = {
            full_name: document.getElementById('profile-full-name').value.trim(),
            nickname: document.getElementById('profile-nickname').value.trim(),
            specialization: document.getElementById('profile-specialization').value.trim(),
            bio: document.getElementById('profile-bio').value.trim(),
            profile_photo: document.getElementById('profile-photo-url').value.trim()
        };

        const res = await api.put('/barber/profile', payload);
        btn.disabled = false;
        btn.textContent = 'Save Profile';

        if (!res?.success) {
            showToast(res?.message || 'Failed to update profile.', 'error');
            return;
        }

        showToast('Profile updated.', 'success');
        const user = getUser();
        if (user) {
            user.full_name = res.data.full_name;
            localStorage.setItem('ms_user', JSON.stringify(user));
        }
        document.getElementById('profile-photo-file').value = '';
        currentProfile = res.data;
        await loadProfile();
    });

    document.getElementById('work-image-form')?.addEventListener('submit', async (e) => {
        e.preventDefault();
        const btn = document.getElementById('btn-add-work');
        btn.disabled = true;
        btn.textContent = 'Adding...';

        try {
            const fileImage = await readImageFile(document.getElementById('work-image-file'));
            const imageUrl = fileImage || document.getElementById('work-image-url').value.trim();
            if (!imageUrl) throw new Error('Add a work image URL or choose an image file.');

            const res = await api.post('/barber/work-images', { image_url: imageUrl });
            if (!res?.success) throw new Error(res?.message || 'Failed to add work image.');

            showToast('Work image added.', 'success');
            e.target.reset();
            await loadWorks(currentProfile?.id || getUser()?.id);
        } catch (err) {
            showToast(err.message, 'error');
        } finally {
            btn.disabled = false;
            btn.textContent = 'Add Work Image';
        }
    });
}

async function loadWorks(barberId) {
    const grid = document.getElementById('works-grid');
    if (!grid || !barberId) return;

    grid.innerHTML = '<div class="works-empty">Loading work images...</div>';
    const res = await api.get(`/barber/work-images/${barberId}`, false);
    if (!res?.success || !res.data.length) {
        grid.innerHTML = '<div class="works-empty">No work images uploaded yet.</div>';
        return;
    }

    grid.innerHTML = res.data.map(work => `
        <div class="work-thumb">
            <img src="${work.image_url}" alt="Barber work image" loading="lazy">
            <button type="button" class="work-delete-btn" onclick="deleteWorkImage(${work.id})">Delete</button>
        </div>
    `).join('');
}

async function deleteWorkImage(id) {
    if (!confirm('Are you sure you want to delete this work image?')) return;
    const res = await api.delete(`/barber/work-images/${id}`);
    if (res?.success) {
        showToast('Work image deleted.', 'success');
        await loadWorks(currentProfile?.id || getUser()?.id);
    } else {
        showToast(res?.message || 'Failed to delete image.', 'error');
    }
}

// ─── Change password ──────────────────────────────────────────
function initChangePassword() {
    document.getElementById('change-pw-form')?.addEventListener('submit', async (e) => {
        e.preventDefault();
        const current = document.getElementById('pw-current')?.value;
        const newPw   = document.getElementById('pw-new')?.value;
        const confirm = document.getElementById('pw-confirm')?.value;
        const btn     = document.getElementById('btn-change-pw');

        if (newPw !== confirm) return showToast('Passwords do not match.', 'error');
        if ((newPw || '').length < 6) return showToast('Password must be 6+ characters.', 'error');

        btn.disabled    = true;
        btn.textContent = 'Updating...';

        const res = await api.put('/auth/change-password', {
            current_password: current,
            new_password:     newPw
        });

        btn.disabled    = false;
        btn.textContent = 'Update Password';

        if (res?.success) {
            showToast('Password updated successfully.', 'success');
            e.target.reset();
        } else {
            showToast(res?.message || 'Failed to update password.', 'error');
        }
    });
}

// ─── Table helpers ────────────────────────────────────────────
function loading(cols) {
    return `<tr><td colspan="${cols}" style="text-align:center;padding:28px;color:var(--text-muted);">
        <span class="spinner" style="display:inline-block;"></span> Loading...
    </td></tr>`;
}

function errorRow(msg, cols) {
    return `<tr><td colspan="${cols}" style="text-align:center;padding:28px;color:#c07070;">
        ${msg}
    </td></tr>`;
}
