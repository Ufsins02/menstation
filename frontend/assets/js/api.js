// ============================================================
// Shared API utilities for MenStation dashboards.
// ============================================================

const normalizeApiBase = (value) => {
    const raw = String(value || '').trim();
    if (!raw) return '/api';
    return raw.replace(/\/+$/, '').replace(/\/api$/i, '') + '/api';
};

const API_BASE = normalizeApiBase(
    window.MENSTATION_API_BASE ||
    document.querySelector('meta[name="api-base"]')?.content ||
    localStorage.getItem('ms_api_base')
);

const getToken = () => localStorage.getItem('ms_token');

const getUser = () => {
    try {
        const raw = localStorage.getItem('ms_user');
        return raw ? JSON.parse(raw) : null;
    } catch {
        localStorage.removeItem('ms_user');
        return null;
    }
};

const saveSession = (token, user) => {
    localStorage.setItem('ms_token', token);
    localStorage.setItem('ms_user', JSON.stringify(user));
};

const clearSession = () => {
    localStorage.removeItem('ms_token');
    localStorage.removeItem('ms_user');
};

const getBasePath = () => {
    const p = window.location.pathname;
    return p.substring(0, p.lastIndexOf('/') + 1);
};

const goTo = (page) => {
    window.location.href = getBasePath() + page;
};

const dashboardFor = (role) => {
    if (role === 'admin' || role === 'owner') return 'admin-dashboard.html';
    if (role === 'barber') return 'barber-dashboard.html';
    if (role === 'staff') return 'staff-dashboard.html';
    return 'login.html';
};

const requireAuth = (roles = []) => {
    const token = getToken();
    const user = getUser();
    if (!token || !user) {
        goTo('login.html');
        return false;
    }

    const allowed = Array.isArray(roles) ? roles : [roles];
    const actualRole = user.role === 'owner' ? 'admin' : user.role;
    if (user.role !== actualRole) {
        user.role = actualRole;
        localStorage.setItem('ms_user', JSON.stringify(user));
    }

    if (allowed.length && !allowed.includes(actualRole)) {
        goTo(dashboardFor(actualRole));
        return false;
    }
    return true;
};

const redirectIfLoggedIn = () => {
    const user = getUser();
    if (getToken() && user) goTo(dashboardFor(user.role));
};

const logout = () => {
    clearSession();
    goTo('login.html');
};

const buildApiUrl = (endpoint) => {
    const raw = String(endpoint || '').trim();
    const clean = raw.startsWith('/api/')
        ? raw.slice(4)
        : raw.startsWith('/')
            ? raw
            : `/${raw}`;
    return `${API_BASE}${clean}`;
};

const apiCall = async (method, endpoint, data = null, auth = true) => {
    const headers = { 'Content-Type': 'application/json', Accept: 'application/json' };
    if (auth) {
        const token = getToken();
        if (token) headers.Authorization = `Bearer ${token}`;
    }

    const verb = method.toUpperCase();
    const config = { method: verb, headers };
    if (data !== null && data !== undefined && verb !== 'GET') {
        config.body = JSON.stringify(data);
    }

    try {
        const response = await fetch(buildApiUrl(endpoint), config);
        const contentType = response.headers.get('content-type') || '';
        if (!contentType.includes('application/json')) {
            return {
                status: response.status,
                success: false,
                data: null,
                message: `Unexpected response (HTTP ${response.status}). Check the API URL configuration.`
            };
        }

        const result = await response.json();
        if (result && typeof result.success === 'boolean' && result.data === undefined) {
            result.data = null;
        }

        if (response.status === 403 && result.message?.toLowerCase().includes('expired')) {
            clearSession();
            goTo('login.html');
            return null;
        }

        return { status: response.status, ...result };
    } catch {
        return {
            success: false,
            data: null,
            message: 'Cannot reach the server. Check the API URL configuration.'
        };
    }
};

const api = {
    get: (endpoint, auth = true) => apiCall('GET', endpoint, null, auth),
    post: (endpoint, data, auth = true) => apiCall('POST', endpoint, data, auth),
    put: (endpoint, data, auth = true) => apiCall('PUT', endpoint, data, auth),
    delete: (endpoint, auth = true) => apiCall('DELETE', endpoint, null, auth)
};

const showToast = (msg, type = 'success') => {
    document.getElementById('ms-toast')?.remove();
    const toast = document.createElement('div');
    toast.id = 'ms-toast';
    toast.className = `toast toast-${type}`;
    toast.innerHTML = `<span class="toast-icon">${type === 'success' ? 'OK' : type === 'error' ? 'ERR' : 'INFO'}</span><span>${msg}</span>`;
    document.body.appendChild(toast);
    requestAnimationFrame(() => requestAnimationFrame(() => toast.classList.add('show')));
    setTimeout(() => {
        toast.classList.remove('show');
        setTimeout(() => toast.remove(), 350);
    }, 4000);
};

const formatPeso = (n) =>
    '\u20B1' + parseFloat(n || 0).toLocaleString('en-PH', {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2
    });

const formatDate = (d) => {
    if (!d) return '-';
    try {
        return new Date(d).toLocaleDateString('en-PH', { year: 'numeric', month: 'short', day: 'numeric' });
    } catch {
        return d;
    }
};

const formatTime = (t) => {
    if (!t) return '-';
    try {
        const [h, m] = String(t).split(':');
        const hh = parseInt(h, 10);
        return `${hh % 12 || 12}:${m} ${hh < 12 ? 'AM' : 'PM'}`;
    } catch {
        return t;
    }
};

const formatDateTime = (d) => {
    if (!d) return '-';
    try {
        return new Date(d).toLocaleString('en-PH', {
            year: 'numeric',
            month: 'short',
            day: 'numeric',
            hour: '2-digit',
            minute: '2-digit'
        });
    } catch {
        return d;
    }
};

const getToday = () => new Date().toISOString().split('T')[0];
const getCurrentMonth = () => new Date().toISOString().slice(0, 7);

const emptyState = (msg = 'No data yet.', colspan = 1) =>
    colspan > 1
        ? `<tr><td colspan="${colspan}" style="text-align:center;padding:32px;color:var(--text-muted);font-size:13px;">${msg}</td></tr>`
        : `<div style="text-align:center;padding:40px 20px;color:var(--text-muted);font-size:13px;">${msg}</div>`;

Object.assign(window, {
    API_BASE,
    api,
    getToken,
    getUser,
    saveSession,
    clearSession,
    goTo,
    requireAuth,
    dashboardFor,
    redirectIfLoggedIn,
    logout,
    showToast,
    formatPeso,
    formatDate,
    formatTime,
    formatDateTime,
    getToday,
    getCurrentMonth,
    emptyState
});
