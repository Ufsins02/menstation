// ============================================================
// frontend/assets/js/staff.js
// Staff (Cashier) Dashboard - full implementation
// Pages: POS - Reservations - Sales Log
// API:   /api/staff/*  +  /api/staff/reservations/*
// Depends on: api.js (loaded before this file)
// ============================================================

requireAuth(['staff']);

// ─── State ────────────────────────────────────────────────────
let _services = [];   // cached service list {id, name, price, duration_minutes}
let _barbers  = [];   // cached barber list  {id, full_name, commission_rate}
let _inventory = [];   // cached inventory list for stock usage

// ─── Page metadata ────────────────────────────────────────────
const PAGE = {
    pos:          { title: 'Point of Sale',    subtitle: 'Record a walk-in or complete a reservation service' },
    reservations: { title: 'Reservations',     subtitle: "Today's booking schedule for your branch" },
    calendar:     { title: 'Reservation Calendar', subtitle: 'Read-only booking calendar for your branch' },
    sales:        { title: 'Sales Log',        subtitle: 'Transaction history for your branch' },
    inventory:    { title: 'Inventory Usage',  subtitle: 'Record stock usage without adding or deleting items' }
};

// ════════════════════════════════════════════════════════════
// BOOTSTRAP - runs once when DOM is ready
// ════════════════════════════════════════════════════════════
document.addEventListener('DOMContentLoaded', async () => {
    initUserInfo();
    initTopbarDate();
    initNav();
    initSidebar();
    initPosForm();
    initInventoryForm();

    // Set default dates
    const today    = getToday();
    const firstDay = today.slice(0, 8) + '01';

    const resDateEl  = document.getElementById('res-date');
    const salesFromEl = document.getElementById('sales-from');
    const salesToEl   = document.getElementById('sales-to');
    const calendarEl  = document.getElementById('calendar-month');

    if (resDateEl)   resDateEl.value   = today;
    if (salesFromEl) salesFromEl.value = firstDay;
    if (salesToEl)   salesToEl.value   = today;
    if (calendarEl)  calendarEl.value  = today.slice(0, 7);

    // Set the POS date label
    setEl('pos-date-label', formatDate(today));

    // Pre-load barbers + services in parallel (needed for POS dropdowns)
    await Promise.all([fetchBarbers(), fetchServices()]);

    // Load initial page data
    await Promise.all([loadStats(), loadTodaySales()]);
    loadReservations(today);   // also pre-load today's reservations for the res-select dropdown
});

// ─── User info ────────────────────────────────────────────────
function initUserInfo() {
    const user = getUser();
    if (!user) return;
    setEl('sidebar-name',   user.full_name);
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
    // Update active nav item
    document.querySelectorAll('.nav-item').forEach(i => i.classList.remove('active'));
    document.querySelector(`.nav-item[data-page="${name}"]`)?.classList.add('active');

    // Show the correct section
    document.querySelectorAll('.page-section').forEach(s => s.classList.remove('active'));
    document.getElementById(`page-${name}`)?.classList.add('active');

    // Update topbar title + subtitle
    const meta = PAGE[name] || { title: name, subtitle: '' };
    setEl('page-title',    meta.title);
    setEl('page-subtitle', meta.subtitle);

    // Lazy-load data when navigating
    switch (name) {
        case 'pos':
            loadStats();
            loadTodaySales();
            break;
        case 'reservations':
            loadReservations(document.getElementById('res-date')?.value || getToday());
            break;
        case 'calendar':
            loadCalendar();
            break;
        case 'sales':
            loadSalesLog();
            break;
        case 'inventory':
            loadInventory();
            break;
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

// ─── Shared helpers ───────────────────────────────────────────
function setEl(id, val) {
    const el = document.getElementById(id);
    if (el) el.textContent = val;
}

function initials(name) {
    return (name || '?').split(' ').map(n => n[0]).join('').slice(0, 2).toUpperCase();
}

function loadingRow(cols) {
    return `<tr><td colspan="${cols}"
        style="text-align:center;padding:28px;color:var(--text-muted);">
        <span class="spinner"></span> Loading...
    </td></tr>`;
}

function emptyRow(msg, cols) {
    return `<tr><td colspan="${cols}"
        style="text-align:center;padding:32px;color:var(--text-muted);font-size:13px;">
        ${msg}
    </td></tr>`;
}

function errRow(msg, cols) {
    return `<tr><td colspan="${cols}"
        style="text-align:center;padding:28px;color:var(--danger);font-size:13px;">
        ${msg}
    </td></tr>`;
}

// Map status string → CSS badge class
function statusBadgeClass(status) {
    const map = {
        pending:     'badge-pending',
        confirmed:   'badge-confirmed',
        in_progress: 'badge-in-progress',
        done:        'badge-done',
        cancelled:   'badge-cancelled'
    };
    return map[status] || 'badge-khaki';
}

// Map payment method → CSS badge class
function payBadgeClass(method) {
    const map = { cash: 'badge-cash', gcash: 'badge-gcash', card: 'badge-card' };
    return map[method] || 'badge-khaki';
}

// ════════════════════════════════════════════════════════════
// STATS - fills the four-cell strip on the POS page
// ════════════════════════════════════════════════════════════
async function loadStats() {
    const res = await api.get('/staff/stats');
    if (!res?.success) {
        return;
    }
    const s = res.stats;
    setEl('stat-today-count',   s.today_count       ?? 0);
    setEl('stat-today-sales',   formatPeso(s.today_sales));
    setEl('stat-barbers',       s.active_barbers     ?? 0);
    setEl('stat-reservations',  s.today_reservations ?? 0);
}

// ════════════════════════════════════════════════════════════
// FETCH DROPDOWNS - barbers and services for POS selects
// ════════════════════════════════════════════════════════════
async function fetchBarbers() {
    const res = await api.get('/staff/barbers');
    if (!res?.success) {
        return;
    }
    _barbers = res.data;

    const sel = document.getElementById('pos-barber');
    if (!sel) return;

    if (!_barbers.length) {
        sel.innerHTML = '<option value="">No barbers assigned to this branch</option>';
        return;
    }

    sel.innerHTML = '<option value="">Select barber...</option>' +
        _barbers.map(b =>
            `<option value="${b.id}">${b.full_name}` +
            (b.specialization ? ` - ${b.specialization}` : '') +
            `</option>`
        ).join('');
}

async function fetchServices() {
    const res = await api.get('/staff/services');
    if (!res?.success) {
        return;
    }
    _services = res.data;

    const sel = document.getElementById('pos-service');
    if (!sel) return;

    if (!_services.length) {
        sel.innerHTML = '<option value="">No services configured for this branch</option>';
        return;
    }

    let html = '<option value="">Select service...</option>';
    _services.forEach(s => {
            html += `<option value="${s.id}" data-price="${s.price}" data-dur="${s.duration_minutes}">${s.name} - ${formatPeso(s.price)} - ${(s.duration_minutes || s.duration || 30)} min</option>`;
    });

    sel.innerHTML = html;
}

// ════════════════════════════════════════════════════════════
// POS FORM - price preview, service→barber linking, submission
// ════════════════════════════════════════════════════════════
function initPosForm() {
    // When service changes → update price preview
    document.getElementById('pos-service')?.addEventListener('change', function () {
        const opt    = this.options[this.selectedIndex];
        const price  = opt?.dataset?.price;
        const dur    = opt?.dataset?.dur;
        const preview = document.getElementById('pos-price-preview');
        const display = document.getElementById('pos-price-display');

        if (price && parseFloat(price) > 0 && preview && display) {
            display.textContent = formatPeso(price);
            const note = document.querySelector('.pos-price-note');
            if (note && dur) {
                note.textContent = `Duration: ${dur} min. Price is fixed - contact admin to modify.`;
            }
            preview.classList.remove('hidden');
        } else if (preview) {
            preview.classList.add('hidden');
        }
    });

    // Form submission
    document.getElementById('pos-form')?.addEventListener('submit', handlePosSale);
}

function initInventoryForm() {
    document.getElementById('inventory-usage-form')?.addEventListener('submit', handleInventoryUsage);
}

async function handlePosSale(e) {
    e.preventDefault();

    const serviceId     = document.getElementById('pos-service')?.value;
    const barberId      = document.getElementById('pos-barber')?.value;
    const customerName  = document.getElementById('pos-customer')?.value.trim();
    const paymentMethod = document.getElementById('pos-payment')?.value;
    const reservationId = document.getElementById('pos-reservation')?.value;
    const notes         = document.getElementById('pos-notes')?.value.trim();
    const btn           = document.getElementById('pos-btn');

    // Client-side validation
    if (!serviceId) {
        showToast('Please select a service.', 'error');
        return;
    }
    if (!barberId) {
        showToast('Please select a barber.', 'error');
        return;
    }

    // Loading state
    const origText = btn.textContent;
    btn.disabled   = true;
    btn.textContent = 'Recording...';

    const payload = {
        service_id:      parseInt(serviceId),
        barber_id:       parseInt(barberId),
        customer_name:   customerName || 'Walk-in',
        payment_method:  paymentMethod || 'cash',
        notes:           notes || null
    };

    // Link to a reservation if one was selected
    if (reservationId) {
        payload.reservation_id = parseInt(reservationId);
    }

    const res = await api.post('/staff/sales', payload);

    btn.disabled   = false;
    btn.textContent = origText;

    if (res?.success) {
        showToast(res.message || 'Sale recorded successfully.', 'success');

        // Flash the form card green briefly
        const card = document.querySelector('.pos-form-card');
        if (card) {
            card.classList.add('sale-success');
            setTimeout(() => card.classList.remove('sale-success'), 1500);
        }

        // Reset form
        e.target.reset();
        document.getElementById('pos-price-preview')?.classList.add('hidden');

        // Refresh today's sales panel + stats
        await Promise.all([loadTodaySales(), loadStats()]);

        // If this was linked to a reservation, refresh reservations
        if (reservationId) {
            await loadReservations(getToday());
        }
    } else {
        const msg = res?.message || 'Failed to record sale. Please try again.';
        showToast(msg, 'error');
    }
}

// ════════════════════════════════════════════════════════════
// TODAY'S SALES - right column on POS page
// ════════════════════════════════════════════════════════════
async function loadTodaySales() {
    const tbody    = document.getElementById('pos-today-tbody');
    const totalLbl = document.getElementById('pos-total-label');
    if (!tbody) return;

    tbody.innerHTML = loadingRow(4);

    const res = await api.get('/staff/sales');   // defaults to today
    if (!res?.success) {
        tbody.innerHTML = errRow('Failed to load today\'s sales.', 4);
        return;
    }

    if (!res.data.length) {
        tbody.innerHTML = emptyRow('No sales recorded today yet.', 4);
        if (totalLbl) totalLbl.textContent = 'Total: ' + formatPeso(0);
        return;
    }

    const total = res.data.reduce((sum, s) => sum + parseFloat(s.amount || 0), 0);
    if (totalLbl) totalLbl.textContent = 'Total: ' + formatPeso(total);

    tbody.innerHTML = res.data.map(s => `
        <tr>
            <td style="font-weight:600;">${s.barber_name}</td>
            <td>${s.service_name}</td>
            <td>${s.customer_name}</td>
            <td style="font-weight:700;color:var(--success);">${formatPeso(s.amount)}</td>
        </tr>`).join('');

    // Refresh the reservation dropdown for any new pending reservations
    await refreshReservationDropdown();
}

// ── Reservation dropdown inside POS form ─────────────────────
// Populated with today's pending/confirmed reservations so staff
// can optionally link a walk-in sale to an existing booking.
async function refreshReservationDropdown() {
    const sel = document.getElementById('pos-reservation');
    if (!sel) return;

    const res = await api.get(`/staff/reservations?date=${getToday()}`);
    if (!res?.success || !res.data.length) {
        sel.innerHTML = '<option value="">Walk-in (no reservation)</option>';
        return;
    }

    // POS links stay single-service; use the Complete button for multi-service reservations.
    const open = res.data
        .filter(r => !['done', 'cancelled'].includes(r.status))
        .filter(r => !Array.isArray(r.service_ids) || r.service_ids.length <= 1);

    if (!open.length) {
        sel.innerHTML = '<option value="">Walk-in (no reservation)</option>';
        return;
    }

    sel.innerHTML = '<option value="">Walk-in (no reservation)</option>' +
        open.map(r =>
            `<option value="${r.id}">` +
            `${formatTime(r.res_time)} - ${r.customer_name} (${r.service_name})` +
            `</option>`
        ).join('');
}

// ════════════════════════════════════════════════════════════
// RESERVATIONS PAGE - view + complete + cancel
// ════════════════════════════════════════════════════════════
async function loadReservations(date) {
    const tbody  = document.getElementById('res-tbody');
    const lbl    = document.getElementById('res-date-label');
    const useDate = date || getToday();

    // Sync the date input
    const dateInput = document.getElementById('res-date');
    if (dateInput) dateInput.value = useDate;

    if (lbl) lbl.textContent = formatDate(useDate);
    if (!tbody) return;

    tbody.innerHTML = loadingRow(6);

    const res = await api.get(`/staff/reservations?date=${useDate}`);
    if (!res?.success) {
        tbody.innerHTML = errRow('Failed to load reservations. Check server connection.', 6);
        return;
    }

    if (!res.data.length) {
        tbody.innerHTML = emptyRow(`No reservations scheduled for ${formatDate(useDate)}.`, 6);
        return;
    }

    tbody.innerHTML = res.data.map(r => {
        const isDone      = r.status === 'done';
        const isCancelled = r.status === 'cancelled';
        const isActive    = !isDone && !isCancelled;

        const completeBtn = isActive
            ? `<button class="btn-complete"
                       onclick="completeReservation(${r.id}, '${escHtml(r.customer_name)}', '${escHtml(r.service_name)}')"
                       title="Mark done and record sale">
                   Complete
               </button>`
            : '';

        const cancelBtn = isActive
            ? `<button class="btn-cancel-res"
                       onclick="cancelReservation(${r.id}, '${escHtml(r.customer_name)}')"
                       title="Cancel this reservation">
                   Cancel
               </button>`
            : '';

        const statusDisplay = r.status.replace('_', ' ');

        return `<tr>
            <td style="font-family:monospace;font-weight:700;">${formatTime(r.res_time)}</td>
            <td>
                <div style="font-weight:600;">${r.customer_name}</div>
                ${r.customer_phone
                    ? `<div style="font-size:11px;color:var(--text-muted);">${r.customer_phone}</div>`
                    : ''}
            </td>
            <td>${r.barber_name}</td>
            <td>
                <div>${r.service_name}</div>
                <div style="font-size:11px;color:var(--success);">${formatPeso(r.service_price)}</div>
            </td>
            <td>
                <span class="badge ${statusBadgeClass(r.status)}">${statusDisplay}</span>
            </td>
            <td>
                <div class="res-actions">
                    ${completeBtn}
                    ${cancelBtn}
                    ${isDone && r.sale_id
                        ? `<span style="font-size:11px;color:var(--success);">Sale #${r.sale_id}</span>`
                        : ''}
                </div>
            </td>
        </tr>`;
    }).join('');
}

// ── Complete a reservation → auto-creates sale ────────────────
async function completeReservation(resId, customerName, serviceName) {
    const payMethod = prompt(
        `Complete reservation for ${customerName}?\n` +
        `Service: ${serviceName}\n\n` +
        `Payment method (cash / gcash / card / other):\n` +
        `Press Cancel to abort.`,
        'cash'
    );

    // Cancelled the prompt
    if (payMethod === null) return;

    const method = ['cash', 'gcash', 'card', 'other'].includes(payMethod.trim().toLowerCase())
        ? payMethod.trim().toLowerCase()
        : 'cash';

    // Disable all action buttons briefly
    document.querySelectorAll('.btn-complete, .btn-cancel-res')
        .forEach(b => { b.disabled = true; });

    const res = await api.put(`/staff/reservations/${resId}/complete`, {
        payment_method: method
    });

    document.querySelectorAll('.btn-complete, .btn-cancel-res')
        .forEach(b => { b.disabled = false; });

    if (res?.success) {
        showToast(res.message || 'Reservation completed and sale recorded.', 'success');
        // Refresh both tables
        const currentDate = document.getElementById('res-date')?.value || getToday();
        await Promise.all([
            loadReservations(currentDate),
            loadStats()
        ]);
        // If on POS page, also refresh today's sales panel
        if (document.getElementById('page-pos')?.classList.contains('active')) {
            await loadTodaySales();
        }
    } else {
        const msg = res?.message || 'Failed to complete reservation.';
        showToast(msg, 'error');
    }
}

// ── Cancel a reservation ──────────────────────────────────────
async function cancelReservation(resId, customerName) {
    if (!confirm(`Cancel reservation for ${customerName}?\nThis cannot be undone.`)) return;

    document.querySelectorAll('.btn-complete, .btn-cancel-res')
        .forEach(b => { b.disabled = true; });

    const res = await api.delete(`/staff/reservations/${resId}`);

    document.querySelectorAll('.btn-complete, .btn-cancel-res')
        .forEach(b => { b.disabled = false; });

    if (res?.success) {
        showToast(`Reservation for ${customerName} cancelled.`, 'success');
        const currentDate = document.getElementById('res-date')?.value || getToday();
        await loadReservations(currentDate);
        await loadStats();
    } else {
        const msg = res?.message || 'Failed to cancel reservation.';
        showToast(msg, 'error');
    }
}

// ════════════════════════════════════════════════════════════
// SALES LOG - date-filtered transaction history
// ════════════════════════════════════════════════════════════
async function loadSalesLog() {
    const tbody  = document.getElementById('sales-log-tbody');
    const revEl  = document.getElementById('log-total-rev');
    const cntEl  = document.getElementById('log-total-count');

    const dateFrom = document.getElementById('sales-from')?.value;
    const dateTo   = document.getElementById('sales-to')?.value;

    if (!tbody) return;
    tbody.innerHTML = loadingRow(6);
    if (revEl) revEl.textContent = formatPeso(0);
    if (cntEl) cntEl.textContent = '0';

    let ep = '/staff/sales?';
    if (dateFrom) ep += `date_from=${dateFrom}&`;
    if (dateTo)   ep += `date_to=${dateTo}`;

    const res = await api.get(ep);
    if (!res?.success) {
        tbody.innerHTML = errRow('Failed to load sales log. Check server connection.', 6);
        return;
    }

    if (!res.data.length) {
        tbody.innerHTML = emptyRow('No transactions found for this period.', 6);
        return;
    }

    // Compute totals
    const totalRev = res.data.reduce((s, r) => s + parseFloat(r.amount || 0), 0);
    if (revEl) revEl.textContent = formatPeso(totalRev);
    if (cntEl) cntEl.textContent = res.data.length;

    tbody.innerHTML = res.data.map(s => `
        <tr>
            <td>${formatDate(s.sale_date)}</td>
            <td style="font-weight:600;">${s.barber_name}</td>
            <td>${s.service_name}</td>
            <td>${s.customer_name}</td>
            <td style="font-weight:700;color:var(--success);">${formatPeso(s.amount)}</td>
            <td>
                <span class="badge ${payBadgeClass(s.payment_method)}">${s.payment_method}</span>
            </td>
        </tr>`).join('') + `
        <tr style="background:var(--bg-elevated);">
            <td colspan="4"
                style="text-align:right;font-weight:600;padding:12px 14px;
                       font-size:11px;color:var(--text-muted);
                       text-transform:uppercase;letter-spacing:0.08em;">
                Total (${res.data.length} transactions)
            </td>
            <td style="font-weight:700;color:var(--success);font-size:15px;padding:12px 14px;">
                ${formatPeso(totalRev)}
            </td>
            <td></td>
        </tr>`;
}

// ─── Security helper - escape for HTML attributes ─────────────
async function loadCalendar() {
    const tbody = document.getElementById('calendar-tbody');
    const countEl = document.getElementById('calendar-count');
    const month = document.getElementById('calendar-month')?.value || getToday().slice(0, 7);

    if (!tbody) return;
    tbody.innerHTML = loadingRow(6);
    if (countEl) countEl.textContent = '0 bookings';

    const res = await api.get(`/staff/calendar?month=${month}`);
    if (!res?.success) {
        tbody.innerHTML = errRow(res?.message || 'Failed to load calendar.', 6);
        return;
    }

    if (countEl) countEl.textContent = `${res.data.length} booking${res.data.length === 1 ? '' : 's'}`;

    if (!res.data.length) {
        tbody.innerHTML = emptyRow('No reservations for this month.', 6);
        return;
    }

    tbody.innerHTML = res.data.map(r => `
        <tr>
            <td>${formatDate(r.res_date)}</td>
            <td>${String(r.res_time).slice(0, 5)}</td>
            <td>${r.customer_name}</td>
            <td>${r.barber_name}</td>
            <td>${r.service_name}</td>
            <td><span class="badge ${statusBadgeClass(r.status)}">${r.status}</span></td>
        </tr>
    `).join('');
}

async function loadInventory() {
    const tbody = document.getElementById('inventory-tbody');
    const sel = document.getElementById('inventory-item');
    const countEl = document.getElementById('inventory-count');

    if (tbody) tbody.innerHTML = loadingRow(5);
    if (countEl) countEl.textContent = '0 items';

    const res = await api.get('/staff/inventory');
    if (!res?.success) {
        if (tbody) tbody.innerHTML = errRow(res?.message || 'Failed to load inventory.', 5);
        if (sel) sel.innerHTML = '<option value="">Inventory unavailable</option>';
        return;
    }

    _inventory = res.data || [];
    if (countEl) countEl.textContent = `${_inventory.length} item${_inventory.length === 1 ? '' : 's'}`;

    if (sel) {
        sel.innerHTML = '<option value="">Select item...</option>' + _inventory.map(item => `
            <option value="${item.id}">
                ${item.name} (${Number(item.quantity_in_stock || 0)} ${item.unit || 'unit'})
            </option>
        `).join('');
    }

    if (!tbody) return;
    if (!_inventory.length) {
        tbody.innerHTML = emptyRow('No inventory items found for this branch.', 5);
        return;
    }

    tbody.innerHTML = _inventory.map(item => {
        const stock = Number(item.quantity_in_stock || 0);
        const reorder = Number(item.reorder_level || 0);
        const low = stock <= reorder;
        return `
            <tr>
                <td style="font-weight:600;">${item.name}</td>
                <td>${item.category || '-'}</td>
                <td>${item.unit || '-'}</td>
                <td style="font-weight:700;color:${low ? 'var(--danger)' : 'var(--success)'};">${stock}</td>
                <td>${reorder}</td>
            </tr>
        `;
    }).join('');
}

async function handleInventoryUsage(e) {
    e.preventDefault();

    const inventoryId = document.getElementById('inventory-item')?.value;
    const qty = document.getElementById('inventory-used')?.value;
    const reason = document.getElementById('inventory-reason')?.value.trim();
    const btn = document.getElementById('inventory-update-btn');

    if (!inventoryId) {
        showToast('Please select an inventory item.', 'error');
        return;
    }
    if (!qty || Number(qty) <= 0) {
        showToast('Quantity used must be greater than zero.', 'error');
        return;
    }

    const original = btn?.textContent || 'Update Stock';
    if (btn) {
        btn.disabled = true;
        btn.textContent = 'Updating...';
    }

    const res = await api.put('/staff/inventory/update', {
        inventory_id: parseInt(inventoryId),
        quantity_used: Number(qty),
        reason
    });

    if (res?.success) {
        showToast(res.message || 'Inventory updated.', 'success');
        e.target.reset();
        await loadInventory();
    } else {
        showToast(res?.message || 'Failed to update inventory.', 'error');
    }

    if (btn) {
        btn.disabled = false;
        btn.textContent = original;
    }
}

function escHtml(str) {
    return (str || '').replace(/'/g, "\\'").replace(/"/g, '&quot;');
} 
