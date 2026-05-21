// ============================================================
// backend/controllers/staffController.js
// Staff (cashier) operations:
// - Create sales from completed services or walk-ins
// - Create / manage reservations
// - View their branch data
// - CANNOT edit service prices or service details
// ============================================================

const db = require('../config/db');
const { toServiceResources } = require('../utils/servicePresenter');
const logger = require('../utils/logger');

// ── Helpers ──────────────────────────────────────────────────
const oid = (req) => req.user.owner_id || req.user.id;
const bid = (req) => req.user.branch_id;   // Staff are locked to their branch

const requireBranch = (req, res) => {
    if (bid(req)) return true;
    res.status(400).json({ success: false, message: 'Staff account is not assigned to a branch.' });
    return false;
};

const shapeReservationRows = (rows) => rows.map(row => {
    const services = String(row.services_blob || '')
        .split('||')
        .filter(Boolean)
        .map(item => {
            const [id, name, price, duration] = item.split('::');
            return {
                id: parseInt(id, 10),
                name,
                price: parseFloat(price || 0),
                duration_minutes: parseInt(duration || 30, 10)
            };
        });

    if (!services.length && row.primary_service_id) {
        services.push({
            id: row.primary_service_id,
            name: row.primary_service_name,
            price: parseFloat(row.primary_service_price || 0),
            duration_minutes: parseInt(row.duration_min || 30, 10)
        });
    }

    const servicePrice = services.reduce((sum, svc) => sum + parseFloat(svc.price || 0), 0);
    const serviceName = services.map(svc => svc.name).join(', ') || row.primary_service_name || '';
    const { services_blob, primary_service_id, primary_service_name, primary_service_price, ...clean } = row;

    return {
        ...clean,
        services,
        service_ids: services.map(svc => svc.id),
        service_name: serviceName,
        service_price: servicePrice
    };
});

const getReservationServiceItems = async (reservationId, legacyReservation) => {
    const [items] = await db.query(
        `SELECT rs.service_id, rs.price, rs.duration_minutes, s.name
         FROM reservation_services rs
         JOIN services s ON s.id=rs.service_id
         WHERE rs.reservation_id=?
         ORDER BY rs.id ASC`,
        [reservationId]
    );

    if (items.length) return items;
    return [{
        service_id: legacyReservation.service_id,
        price: legacyReservation.service_price,
        duration_minutes: legacyReservation.duration_min || 30,
        name: legacyReservation.service_name
    }];
};

// ============================================================
// STAFF DASHBOARD STATS  GET /api/staff/stats
// ============================================================
const getStaffStats = async (req, res) => {
    try {
        if (!requireBranch(req, res)) return;
        const branchId = bid(req);
        const today    = new Date().toISOString().split('T')[0];
        const firstDay = today.slice(0, 8) + '01';

        const [[todaySales]] = await db.query(
            'SELECT COALESCE(SUM(amount),0) AS t, COUNT(*) AS c FROM sales WHERE branch_id=? AND sale_date=?',
            [branchId, today]
        );
        const [[monthlySales]] = await db.query(
            'SELECT COALESCE(SUM(amount),0) AS t FROM sales WHERE branch_id=? AND sale_date>=?',
            [branchId, firstDay]
        );
        const [[pendingRes]] = await db.query(
            "SELECT COUNT(*) AS t FROM reservations WHERE branch_id=? AND res_date=? AND status IN ('pending','confirmed')",
            [branchId, today]
        );
        const [[activeBarbers]] = await db.query(
            `SELECT COUNT(*) AS t FROM users u JOIN roles r ON u.role_id=r.id
             WHERE r.name='barber' AND u.branch_id=? AND u.status='approved' AND u.is_active=1`,
            [branchId]
        );

        return res.json({
            success: true,
            stats: {
                today_sales:       parseFloat(todaySales.t),
                today_count:       todaySales.c,
                monthly_sales:     parseFloat(monthlySales.t),
                today_reservations:pendingRes.t,
                active_barbers:    activeBarbers.t
            }
        });
    } catch (err) {
        logger.error('[STAFF-STATS]', err.message);
        return res.status(500).json({ success: false, message: 'Server error.' });
    }
};

// ============================================================
// GET SERVICES  GET /api/staff/services
// Read-only - staff can VIEW services but NOT modify prices
// ============================================================
const getServices = async (req, res) => {
    try {
        if (!requireBranch(req, res)) return;
        const [rows] = await db.query(
            `SELECT id, name, price, duration_minutes, category, description, image_url
             FROM services
             WHERE is_active=1 AND (branch_id=? OR branch_id IS NULL)
             ORDER BY name`,
            [bid(req)]
        );
        return res.json({ success: true, data: toServiceResources(rows, { includeImage: false }) });
    } catch (err) {
        return res.status(500).json({ success: false, message: 'Server error.' });
    }
};

// ============================================================
// GET BARBERS FOR THIS BRANCH  GET /api/staff/barbers
// Staff needs this for assigning services
// ============================================================
const getBranchBarbers = async (req, res) => {
    try {
        if (!requireBranch(req, res)) return;
        const [rows] = await db.query(
            `SELECT u.id, u.full_name, u.phone, b.specialization, b.commission_rate
             FROM users u
             JOIN roles  r ON u.role_id = r.id
             JOIN barbers b ON b.user_id = u.id
             WHERE r.name='barber' AND u.branch_id=? AND u.status='approved' AND u.is_active=1
             ORDER BY u.full_name`,
            [bid(req)]
        );
        return res.json({ success: true, data: rows });
    } catch (err) {
        return res.status(500).json({ success: false, message: 'Server error.' });
    }
};

// ============================================================
// CREATE SALE  POST /api/staff/sales
// Staff creates a sale for a completed service.
// ENFORCED: price comes FROM the services table, not from the request body.
// This prevents any price override by the staff role.
// ============================================================
const createSale = async (req, res) => {
    try {
        if (!requireBranch(req, res)) return;
        const { service_id, barber_id, customer_name, payment_method, notes, reservation_id } = req.body;

        if (!service_id || !barber_id) {
            return res.status(400).json({ success: false, message: 'service_id and barber_id required.' });
        }

        // ── ENFORCE: fetch price from DB - ignore any amount in request ──
        const [[svc]] = await db.query(
            'SELECT id, name, price FROM services WHERE id=? AND is_active=1 AND (branch_id=? OR branch_id IS NULL)',
            [service_id, bid(req)]
        );
        if (!svc) {
            return res.status(404).json({ success: false, message: 'Service not found in this branch.' });
        }

        // Verify barber is in this branch
        const [[barber]] = await db.query(
            `SELECT u.id, b.commission_rate FROM users u
             JOIN barbers b ON b.user_id=u.id
             JOIN roles r ON u.role_id=r.id
             WHERE u.id=? AND r.name='barber' AND u.branch_id=? AND u.status='approved'`,
            [barber_id, bid(req)]
        );
        if (!barber) {
            return res.status(404).json({ success: false, message: 'Barber not found in this branch.' });
        }

        const amount     = parseFloat(svc.price);
        const commission = (amount * barber.commission_rate) / 100;
        const today      = new Date().toISOString().split('T')[0];

        const [result] = await db.query(
            `INSERT INTO sales
             (owner_id, branch_id, barber_id, service_id, customer_name,
              amount, commission_amount, payment_method, notes, sale_date)
             VALUES (?,?,?,?,?,?,?,?,?,?)`,
            [oid(req), bid(req), barber_id, service_id,
             customer_name || 'Walk-in', amount, commission,
             payment_method || 'cash', notes || null, today]
        );

        // If linked to a reservation, mark it done
        if (reservation_id) {
            await db.query(
                "UPDATE reservations SET status='done', sale_id=? WHERE id=? AND branch_id=?",
                [result.insertId, reservation_id, bid(req)]
            );
        }

        return res.status(201).json({
            success:    true,
            message:    `Sale recorded: ${svc.name} for ${customer_name || 'Walk-in'} - PHP${amount.toFixed(2)}`,
            amount:     amount,
            commission: commission,
            sale_id:    result.insertId
        });
    } catch (err) {
        logger.error('[STAFF-CREATE-SALE]', err.message);
        return res.status(500).json({ success: false, message: 'Server error.' });
    }
};

// ============================================================
// GET TODAY'S SALES  GET /api/staff/sales
// ============================================================
const getSales = async (req, res) => {
    try {
        if (!requireBranch(req, res)) return;
        const { date_from, date_to } = req.query;
        const today = new Date().toISOString().split('T')[0];

        let sql = `
            SELECT s.id, s.customer_name, s.amount, s.commission_amount,
                   s.payment_method, s.sale_date, s.notes,
                   u.full_name AS barber_name, sv.name AS service_name
            FROM sales s
            JOIN users    u  ON s.barber_id  = u.id
            JOIN services sv ON s.service_id = sv.id
            WHERE s.branch_id = ?
        `;
        const params = [bid(req)];

        if (date_from) { sql += ' AND s.sale_date >= ?'; params.push(date_from); }
        else           { sql += ' AND s.sale_date >= ?'; params.push(today);     }
        if (date_to)   { sql += ' AND s.sale_date <= ?'; params.push(date_to); }

        sql += ' ORDER BY s.created_at DESC LIMIT 100';

        const [rows] = await db.query(sql, params);
        return res.json({ success: true, data: rows });
    } catch (err) {
        return res.status(500).json({ success: false, message: 'Server error.' });
    }
};

// ============================================================
// GET RESERVATIONS FOR BRANCH  GET /api/staff/reservations
// ============================================================
const getReservations = async (req, res) => {
    try {
        if (!requireBranch(req, res)) return;
        const { date, status } = req.query;
        const today = new Date().toISOString().split('T')[0];

        let sql = `
            SELECT r.id, r.customer_name, r.customer_phone,
                   r.res_date, r.res_time, r.duration_min,
                   r.status, r.notes, r.sale_id,
                   s.id AS primary_service_id, s.name AS primary_service_name,
                   s.price AS primary_service_price,
                   u.full_name AS barber_name,
                   GROUP_CONCAT(CONCAT(svc.id, '::', REPLACE(svc.name, '::', ' '), '::', rs.price, '::', rs.duration_minutes) ORDER BY rs.id SEPARATOR '||') AS services_blob
            FROM reservations r
            JOIN services s ON r.service_id = s.id
            JOIN users    u ON r.barber_id  = u.id
            LEFT JOIN reservation_services rs ON rs.reservation_id = r.id
            LEFT JOIN services svc ON svc.id = rs.service_id
            WHERE r.branch_id = ?
        `;
        const params = [bid(req)];

        sql += ' AND r.res_date = ?';
        params.push(date || today);

        if (status) { sql += ' AND r.status = ?'; params.push(status); }

        sql += ` GROUP BY r.id, r.customer_name, r.customer_phone, r.res_date, r.res_time,
                  r.duration_min, r.status, r.notes, r.sale_id, s.id, s.name, s.price, u.full_name
                 ORDER BY r.res_time ASC`;

        const [rows] = await db.query(sql, params);
        return res.json({ success: true, data: shapeReservationRows(rows) });
    } catch (err) {
        return res.status(500).json({ success: false, message: 'Server error.' });
    }
};

// ============================================================
// COMPLETE RESERVATION → SALE  PUT /api/staff/reservations/:id/complete
// One-click: mark done + create sale
// ============================================================
const completeReservation = async (req, res) => {
    try {
        if (!requireBranch(req, res)) return;
        const { payment_method } = req.body;
        const resId = req.params.id;

        const [[r]] = await db.query(
            `SELECT r.*, s.price AS service_price, s.name AS service_name
             FROM reservations r JOIN services s ON r.service_id=s.id
             WHERE r.id=? AND r.branch_id=?`,
            [resId, bid(req)]
        );
        if (!r) return res.status(404).json({ success: false, message: 'Reservation not found in your branch.' });
        if (r.status === 'done') return res.status(400).json({ success: false, message: 'Already completed.' });
        if (r.status === 'cancelled') return res.status(400).json({ success: false, message: 'Cannot complete a cancelled reservation.' });

        // Get barber commission rate
        const [[barber]] = await db.query('SELECT commission_rate FROM barbers WHERE user_id=?', [r.barber_id]);
        const rate       = barber ? barber.commission_rate : 50;
        const services = await getReservationServiceItems(resId, r);
        const totalAmount = services.reduce((sum, svc) => sum + parseFloat(svc.price || 0), 0);
        const saleIds = [];
        const conn = await db.getConnection();
        try {
            await conn.beginTransaction();
            for (const svc of services) {
                const amount = parseFloat(svc.price || 0);
                const commission = (amount * rate) / 100;
                const [saleResult] = await conn.query(
                    `INSERT INTO sales
                     (owner_id, branch_id, barber_id, service_id, customer_name,
                      amount, commission_amount, payment_method, notes, sale_date)
                     VALUES (?,?,?,?,?,?,?,?,?,?)`,
                    [r.owner_id, r.branch_id, r.barber_id, svc.service_id,
                     r.customer_name, amount, commission,
                     payment_method || 'cash', `Reservation #${resId}`, r.res_date]
                );
                saleIds.push(saleResult.insertId);
            }

            await conn.query(
                "UPDATE reservations SET status='done', sale_id=?, updated_at=NOW() WHERE id=?",
                [saleIds[0] || null, resId]
            );
            await conn.commit();
        } catch (err) {
            await conn.rollback();
            throw err;
        } finally {
            conn.release();
        }

        return res.json({
            success:  true,
            message:  `${services.map(s => s.name).join(', ')} completed for ${r.customer_name}. Sale of PHP ${totalAmount.toFixed(2)} recorded.`,
            sale_id:  saleIds[0] || null,
            sale_ids: saleIds
        });
    } catch (err) {
        logger.error('[STAFF-COMPLETE-RES]', err.message);
        return res.status(500).json({ success: false, message: 'Server error.' });
    }
};

// ============================================================
// CANCEL RESERVATION  DELETE /api/staff/reservations/:id
// ============================================================
const cancelReservation = async (req, res) => {
    try {
        if (!requireBranch(req, res)) return;
        const resId = req.params.id;

        const [result] = await db.query(
            `UPDATE reservations
             SET status='cancelled', updated_at=NOW()
             WHERE id=? AND branch_id=? AND status NOT IN ('done','cancelled')`,
            [resId, bid(req)]
        );

        if (!result.affectedRows) {
            return res.status(404).json({
                success: false,
                message: 'Reservation not found or already closed.'
            });
        }

        return res.json({ success: true, message: 'Reservation cancelled.' });
    } catch (err) {
        logger.error('[STAFF-CANCEL-RES]', err.message);
        return res.status(500).json({ success: false, message: 'Server error.' });
    }
};

// ============================================================
// GET RESERVATION CALENDAR  GET /api/staff/calendar
// Read-only monthly booking view for the staff role.
// ============================================================
const getCalendar = async (req, res) => {
    try {
        if (!requireBranch(req, res)) return;

        const month = req.query.month || new Date().toISOString().slice(0, 7);
        if (!/^\d{4}-\d{2}$/.test(month)) {
            return res.status(400).json({ success: false, message: 'month must use YYYY-MM format.' });
        }

        const dateFrom = `${month}-01`;
        const lastDayNumber = new Date(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0).getDate();
        const lastDay = `${month}-${String(lastDayNumber).padStart(2, '0')}`;

        const [rows] = await db.query(
            `SELECT r.id, r.customer_name, r.customer_phone, r.res_date, r.res_time,
                    r.duration_min, r.status,
                    s.id AS primary_service_id, s.name AS primary_service_name,
                    s.price AS primary_service_price,
                    GROUP_CONCAT(CONCAT(svc.id, '::', REPLACE(svc.name, '::', ' '), '::', rs.price, '::', rs.duration_minutes) ORDER BY rs.id SEPARATOR '||') AS services_blob,
                    u.full_name AS barber_name
             FROM reservations r
             JOIN services s ON r.service_id=s.id
             JOIN users u ON r.barber_id=u.id
             LEFT JOIN reservation_services rs ON rs.reservation_id=r.id
             LEFT JOIN services svc ON svc.id=rs.service_id
             WHERE r.branch_id=? AND r.res_date BETWEEN ? AND ?
             GROUP BY r.id, r.customer_name, r.customer_phone, r.res_date, r.res_time,
                      r.duration_min, r.status, s.id, s.name, s.price, u.full_name
             ORDER BY r.res_date ASC, r.res_time ASC`,
            [bid(req), dateFrom, lastDay]
        );

        return res.json({ success: true, data: shapeReservationRows(rows) });
    } catch (err) {
        logger.error('[STAFF-CALENDAR]', err.message);
        return res.status(500).json({ success: false, message: 'Server error.' });
    }
};

// ============================================================
// GET INVENTORY  GET /api/staff/inventory
// Staff can view stock but cannot create/delete items.
// ============================================================
const getInventory = async (req, res) => {
    try {
        if (!requireBranch(req, res)) return;

        const [rows] = await db.query(
            `SELECT id, name, category, unit, quantity_in_stock, reorder_level
             FROM inventory
             WHERE branch_id=?
             ORDER BY category, name`,
            [bid(req)]
        );

        return res.json({ success: true, data: rows });
    } catch (err) {
        logger.error('[STAFF-INVENTORY]', err.message);
        return res.status(500).json({ success: false, message: 'Server error.' });
    }
};

// ============================================================
// UPDATE INVENTORY STOCK  PUT /api/staff/inventory/update
// Staff records usage by reducing existing stock. No add/delete.
// ============================================================
const updateInventoryQuantity = async (req, res) => {
    try {
        if (!requireBranch(req, res)) return;

        const { inventory_id, quantity_used, quantity_delta, reason } = req.body;
        if (!inventory_id) {
            return res.status(400).json({ success: false, message: 'inventory_id is required.' });
        }

        let delta;
        if (quantity_used !== undefined && quantity_used !== '') {
            const used = Number(quantity_used);
            if (!Number.isFinite(used) || used <= 0) {
                return res.status(400).json({ success: false, message: 'quantity_used must be greater than zero.' });
            }
            delta = -used;
        } else {
            delta = Number(quantity_delta);
            if (!Number.isFinite(delta) || delta === 0) {
                return res.status(400).json({ success: false, message: 'quantity_delta must be a non-zero number.' });
            }
        }

        const [[item]] = await db.query(
            'SELECT id, name, quantity_in_stock FROM inventory WHERE id=? AND branch_id=?',
            [inventory_id, bid(req)]
        );
        if (!item) {
            return res.status(404).json({ success: false, message: 'Inventory item not found in your branch.' });
        }

        const nextQty = Number(item.quantity_in_stock || 0) + delta;
        if (nextQty < 0) {
            return res.status(400).json({ success: false, message: 'Stock cannot go below zero.' });
        }

        await db.query('UPDATE inventory SET quantity_in_stock=? WHERE id=?', [nextQty, item.id]);
        await db.query(
            `INSERT INTO inventory_adjustments
             (inventory_id, branch_id, user_id, quantity_delta, reason)
             VALUES (?,?,?,?,?)`,
            [item.id, bid(req), req.user.id, delta, reason || 'Staff stock usage']
        );

        return res.json({
            success: true,
            message: 'Inventory stock updated.',
            data: {
                id: item.id,
                name: item.name,
                quantity_in_stock: nextQty
            }
        });
    } catch (err) {
        logger.error('[STAFF-INVENTORY-UPDATE]', err.message);
        return res.status(500).json({ success: false, message: 'Server error.' });
    }
};

module.exports = {
    getStaffStats,
    getServices,
    getBranchBarbers,
    createSale,
    getSales,
    getReservations,
    getCalendar,
    getInventory,
    updateInventoryQuantity,
    completeReservation,
    cancelReservation
};
