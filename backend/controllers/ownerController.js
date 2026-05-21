
// ============================================================
// backend/controllers/ownerController.js
// v2: Full multi-tenant isolation - every query scoped by owner_id
//     + Barber approval system
// ============================================================

const db     = require('../config/db');
const bcrypt = require('bcryptjs');
const fs     = require('fs');
const path   = require('path');
const { requestedBranchId, appendBranchFilter } = require('../utils/branchFilter');
const { toServiceResource, toServiceResources } = require('../utils/servicePresenter');
const logger = require('../utils/logger');

// ── Helper: extract this owner's scoping ID from their token ─
// Owners: owner_id = their own user.id (set at registration)
const oid = (req) => {
    const id = req.user.owner_id || req.user.id;
    if (!id) throw new Error('No owner_id in token - re-login required.');
    return id;
};

const bid = (req) => req.user.branch_id || null;

const targetBranchId = (req) => requestedBranchId(req) || bid(req);

const sendData = (res, data, extra = {}) => res.json({ success: true, data, ...extra });

const sendOk = (res, message, data = {}, status = 200) => res.status(status).json({ success: true, message, data });

const serverError = (res, tag, err) => {
    logger.error(`[${tag}]`, err.message);
    return res.status(500).json({
        success: false,
        message: 'Server error.'
    });
};

const SERVICE_UPLOAD_DIR = path.join(__dirname, '..', '..', 'frontend', 'uploads', 'services');
const SERVICE_IMAGE_EXT = { 'image/jpeg': 'jpg', 'image/jpg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' };

const saveServiceImage = async (body, currentImage = null) => {
    const dataUrl = body.service_image_data || body.image_data || body.image;
    if (!dataUrl) {
        if (body.image_url !== undefined && String(body.image_url || '').trim()) {
            return String(body.image_url).trim();
        }
        return currentImage;
    }

    const match = String(dataUrl).match(/^data:(image\/(?:png|jpe?g|webp));base64,([A-Za-z0-9+/=]+)$/);
    if (!match) {
        const err = new Error('Service image must be a PNG, JPG, or WebP file.');
        err.statusCode = 400;
        throw err;
    }

    const mime = match[1].toLowerCase();
    const buffer = Buffer.from(match[2], 'base64');
    if (!buffer.length || buffer.length > 5 * 1024 * 1024) {
        const err = new Error('Service image must be 5MB or smaller.');
        err.statusCode = 400;
        throw err;
    }

    await fs.promises.mkdir(SERVICE_UPLOAD_DIR, { recursive: true });
    const fileName = `service-${Date.now()}-${Math.round(Math.random() * 1e9)}.${SERVICE_IMAGE_EXT[mime]}`;
    await fs.promises.writeFile(path.join(SERVICE_UPLOAD_DIR, fileName), buffer);
    return `/uploads/services/${fileName}`;
};

const getBranches = async (req, res) => {
    try {
        const [rows] = await db.query(
            `SELECT id, name, location AS address, phone, hours_weekday, hours_weekend, is_active
             FROM branches
             WHERE is_active=1
             ORDER BY id ASC`
        );
        return sendData(res, rows);
    } catch (err) {
        return serverError(res, 'GET-BRANCHES', err);
    }
};

// ============================================================
// DASHBOARD STATS  GET /api/owner/stats
// ============================================================
const getDashboardStats = async (req, res) => {
    try {
        const o          = oid(req);
        const branchId   = requestedBranchId(req);
        const branchSql  = branchId ? ' AND branch_id=?' : '';
        const userBranchSql = branchId ? ' AND u.branch_id=?' : '';
        const today      = new Date().toISOString().split('T')[0];
        const firstMonth = today.slice(0, 8) + '01';

        const [[todaySales]] = await db.query(
            `SELECT COALESCE(SUM(amount),0) AS total FROM sales WHERE owner_id=? AND sale_date=?${branchSql}`,
            branchId ? [o, today, branchId] : [o, today]
        );
        const [[monthlySales]] = await db.query(
            `SELECT COALESCE(SUM(amount),0) AS total FROM sales WHERE owner_id=? AND sale_date>=?${branchSql}`,
            branchId ? [o, firstMonth, branchId] : [o, firstMonth]
        );
        const [[todayCustomers]] = await db.query(
            `SELECT COUNT(*) AS total FROM sales WHERE owner_id=? AND sale_date=?${branchSql}`,
            branchId ? [o, today, branchId] : [o, today]
        );
        const [[monthlyExpenses]] = await db.query(
            `SELECT COALESCE(SUM(amount),0) AS total FROM expenses WHERE owner_id=? AND expense_date>=?${branchSql}`,
            branchId ? [o, firstMonth, branchId] : [o, firstMonth]
        );
        const [[barberCount]] = await db.query(
            `SELECT COUNT(*) AS total FROM users u JOIN roles r ON u.role_id=r.id
             WHERE r.name='barber' AND u.owner_id=? AND u.is_active=1 AND u.status='approved'${userBranchSql}`,
            branchId ? [o, branchId] : [o]
        );
        const [[pendingCount]] = await db.query(
            `SELECT COUNT(*) AS total FROM users u JOIN roles r ON u.role_id=r.id
             WHERE r.name='barber' AND u.status='pending'`
        );
        const [[serviceCount]] = await db.query(
            `SELECT COUNT(*) AS total FROM services WHERE owner_id=? AND is_active=1${branchSql}`,
            branchId ? [o, branchId] : [o]
        );
        const [[lowStock]] = await db.query(
            `SELECT COUNT(*) AS total FROM inventory WHERE owner_id=? AND quantity_in_stock<=reorder_level${branchSql}`,
            branchId ? [o, branchId] : [o]
        );

        const stats = {
                today_sales:      parseFloat(todaySales.total),
                monthly_sales:    parseFloat(monthlySales.total),
                total_sales:      parseFloat(monthlySales.total),
                monthly_expenses: parseFloat(monthlyExpenses.total),
                total_expenses:   parseFloat(monthlyExpenses.total),
                net_profit:       parseFloat(monthlySales.total) - parseFloat(monthlyExpenses.total),
                today_customers:  todayCustomers.total,
                active_barbers:   barberCount.total,
                pending_barbers:  pendingCount.total,
                total_services:   serviceCount.total,
                low_stock_items:  lowStock.total
            };

        return sendData(res, stats, { stats });
    } catch (err) {
        return serverError(res, 'STATS', err);
    }
};

// ============================================================
// SALES CHART  GET /api/owner/sales-chart  (last 7 days)
// ============================================================
const getSalesChart = async (req, res) => {
    try {
        const o = oid(req);
        const params = [o];
        let sql = `
            SELECT DATE_FORMAT(sale_date,'%a %d') AS label,
                   sale_date, SUM(amount) AS total, COUNT(*) AS customers
            FROM sales
            WHERE owner_id=? AND sale_date >= DATE_SUB(CURDATE(), INTERVAL 6 DAY)
        `;
        if (requestedBranchId(req)) {
            sql += ' AND branch_id=?';
            params.push(requestedBranchId(req));
        }
        sql += ' GROUP BY sale_date ORDER BY sale_date ASC';
        const [rows] = await db.query(sql, params);
        return sendData(res, rows);
    } catch (err) {
        return serverError(res, 'CHART', err);
    }
};

// ============================================================
// BARBER PERFORMANCE  GET /api/owner/barber-performance
// ============================================================
const getBarberPerformance = async (req, res) => {
    try {
        const o    = oid(req);
        const from = new Date().toISOString().slice(0, 8) + '01';
        const branchId = requestedBranchId(req);
        const branchJoin = branchId ? ' AND s.branch_id = ?' : '';
        const userBranch = branchId ? ' AND u.branch_id=?' : '';
        const params = branchId ? [from, o, branchId, o, branchId] : [from, o, o];
        const [rows] = await db.query(`
            SELECT u.id, u.full_name, u.profile_photo,
                   COALESCE(SUM(s.amount),0)            AS total_sales,
                   COALESCE(SUM(s.commission_amount),0) AS total_commission,
                   COUNT(s.id)                           AS customers_served,
                   b.commission_rate
            FROM users u
            JOIN roles   r ON u.role_id  = r.id
            JOIN barbers b ON b.user_id  = u.id
            LEFT JOIN sales s ON s.barber_id = u.id
                             AND s.sale_date >= ?
                             AND s.owner_id  = ?
                             ${branchJoin}
            WHERE r.name='barber' AND u.owner_id=? AND u.is_active=1 AND u.status='approved'${userBranch}
            GROUP BY u.id ORDER BY total_sales DESC`, params);
        return sendData(res, rows);
    } catch (err) {
        return serverError(res, 'BARBER-PERF', err);
    }
};

// ============================================================
// SALES  GET /api/owner/sales
// ============================================================
const getSales = async (req, res) => {
    try {
        const o = oid(req);
        const { date_from, date_to, barber_id, limit = 200, offset = 0 } = req.query;

        let sql    = `SELECT s.id, s.customer_name, s.amount, s.commission_amount,
                             s.payment_method, s.sale_date, s.notes,
                             u.full_name AS barber_name, sv.name AS service_name,
                             s.branch_id, br.name AS branch_name
                      FROM sales s
                      JOIN users    u  ON s.barber_id  = u.id
                      JOIN services sv ON s.service_id = sv.id
                      LEFT JOIN branches br ON s.branch_id = br.id
                      WHERE s.owner_id=?`;
        const p   = [o];

        if (date_from) { sql += ' AND s.sale_date>=?'; p.push(date_from); }
        if (date_to)   { sql += ' AND s.sale_date<=?'; p.push(date_to); }
        if (barber_id) { sql += ' AND s.barber_id=?';  p.push(barber_id); }
        if (requestedBranchId(req)) { sql += ' AND s.branch_id=?'; p.push(requestedBranchId(req)); }

        sql += ' ORDER BY s.sale_date DESC, s.created_at DESC LIMIT ? OFFSET ?';
        p.push(parseInt(limit), parseInt(offset));

        const [rows] = await db.query(sql, p);
        return sendData(res, rows);
    } catch (err) {
        return serverError(res, 'GET-SALES', err);
    }
};

// POST /api/owner/sales
const addSale = async (req, res) => {
    try {
        const o = oid(req);
        const { barber_id, service_id, customer_name, amount, payment_method, notes, sale_date } = req.body;
        const branchId = targetBranchId(req);
        if (!barber_id || !service_id)
            return res.status(400).json({ success: false, message: 'barber_id and service_id required.' });
        if (!branchId)
            return res.status(400).json({ success: false, message: 'branch_id is required.' });

        const [[svc]] = await db.query(
            'SELECT id, price, branch_id FROM services WHERE id=? AND owner_id=? AND is_active=1 AND (branch_id=? OR branch_id IS NULL)',
            [service_id, o, branchId]
        );
        if (!svc) return res.status(404).json({ success: false, message: 'Service not found.' });

        const [[b]] = await db.query(
            `SELECT b.commission_rate
             FROM barbers b
             JOIN users u ON b.user_id = u.id
             JOIN roles r ON u.role_id = r.id
             WHERE u.id=? AND u.owner_id=? AND u.branch_id=? AND r.name='barber' AND u.status='approved' AND u.is_active=1`,
            [barber_id, o, branchId]
        );
        if (!b) return res.status(404).json({ success: false, message: 'Active barber not found.' });

        const saleAmount = amount ? parseFloat(amount) : parseFloat(svc.price);
        const rate   = b.commission_rate || 50;
        const comm   = (saleAmount * rate) / 100;
        const [r]    = await db.query(
            `INSERT INTO sales (owner_id,branch_id,barber_id,service_id,customer_name,amount,commission_amount,payment_method,notes,sale_date)
             VALUES (?,?,?,?,?,?,?,?,?,?)`,
            [o, branchId, barber_id, service_id, customer_name || 'Walk-in', saleAmount, comm,
             payment_method || 'cash', notes || null, sale_date || new Date().toISOString().split('T')[0]]
        );
        return sendOk(res, 'Sale recorded.', { id: r.insertId }, 201);
    } catch (err) {
        return serverError(res, 'ADD-SALE', err);
    }
};

// DELETE /api/owner/sales/:id
const deleteSale = async (req, res) => {
    try {
        const o = oid(req);
        await db.query('DELETE FROM sales WHERE id=? AND owner_id=?', [req.params.id, o]);
        return sendOk(res, 'Sale deleted.', { id: Number(req.params.id) });
    } catch (err) {
        return serverError(res, 'UPDATE-BARBER', err);
    }
};

// ============================================================
// BARBERS  GET /api/owner/barbers  (approved + belongs to owner)
// ============================================================
const getBarbers = async (req, res) => {
    try {
        const o = oid(req);
        const p = [o];
        let sql = `
            SELECT u.id, u.full_name, u.email, u.phone, u.profile_photo,
                   u.is_active, u.status, u.created_at, u.branch_id,
                   brn.name AS branch_name,
                   b.commission_rate, b.specialization, b.hire_date, b.bio, b.nickname
            FROM users u
            JOIN roles   r ON u.role_id  = r.id
            JOIN barbers b ON b.user_id  = u.id
            LEFT JOIN branches brn ON u.branch_id = brn.id
            WHERE r.name='barber' AND u.owner_id=?
        `;
        if (requestedBranchId(req)) {
            sql += ' AND u.branch_id=?';
            p.push(requestedBranchId(req));
        }
        sql += ' ORDER BY brn.id ASC, u.full_name ASC';
        const [rows] = await db.query(sql, p);
        return sendData(res, rows);
    } catch (err) {
        return serverError(res, 'GET-BARBERS', err);
    }
};

// ============================================================
// PENDING BARBERS  GET /api/owner/barbers/pending
// Any unassigned pending barber can be claimed by any owner
// ============================================================
const getPendingBarbers = async (req, res) => {
    try {
        const [rows] = await db.query(`
            SELECT u.id, u.full_name, u.email, u.phone, u.created_at,
                   b.specialization, b.commission_rate
            FROM users u
            JOIN roles   r ON u.role_id = r.id
            JOIN barbers b ON b.user_id = u.id
            WHERE r.name='barber' AND u.status='pending'
            ORDER BY u.created_at ASC`);
        return sendData(res, rows);
    } catch (err) {
        return serverError(res, 'PENDING-BARBERS', err);
    }
};

// ============================================================
// APPROVE BARBER  PUT /api/owner/barbers/:id/approve
// ============================================================
const approveBarber = async (req, res) => {
    try {
        const o        = oid(req);
        const barberId = req.params.id;
        const branchId = targetBranchId(req);
        if (!branchId) return res.status(400).json({ success: false, message: 'Branch is required.' });

        const [check] = await db.query(
            `SELECT u.id, u.full_name FROM users u JOIN roles r ON u.role_id=r.id
             WHERE u.id=? AND r.name='barber' AND u.status='pending'`, [barberId]
        );
        if (!check.length)
            return res.status(404).json({ success: false, message: 'Pending barber not found.' });

        const barber = check[0];

        // Approve and assign to this owner
        await db.query(
            "UPDATE users SET status='approved', owner_id=?, branch_id=COALESCE(branch_id, ?) WHERE id=?",
            [o, branchId, barberId]
        );

        // Notify the barber
        await db.query(
            `INSERT INTO notifications (user_id, title, message, type) VALUES (?,?,?,?)`,
            [barberId,
             'Account Approved',
             'Your barber account has been approved. You can now log in to MenStation.',
             'success']
        );

        // Mark the pending notification as read for this owner
        await db.query(
            `UPDATE notifications SET is_read=1
             WHERE user_id=? AND message LIKE ? AND type='warning'`,
            [o, `%${barber.full_name}%`]
        );

        return sendOk(res, `${barber.full_name} approved and can now log in.`, { id: Number(barberId) });
    } catch (err) {
        return serverError(res, 'APPROVE', err);
    }
};

// ============================================================
// REJECT BARBER  PUT /api/owner/barbers/:id/reject
// ============================================================
const rejectBarber = async (req, res) => {
    try {
        const o        = oid(req);
        const barberId = req.params.id;
        const { reason } = req.body;

        const [check] = await db.query(
            `SELECT u.id, u.full_name FROM users u JOIN roles r ON u.role_id=r.id
             WHERE u.id=? AND r.name='barber' AND u.status='pending'`, [barberId]
        );
        if (!check.length)
            return res.status(404).json({ success: false, message: 'Pending barber not found.' });

        const barber = check[0];

        await db.query("UPDATE users SET status='rejected' WHERE id=?", [barberId]);

        const msg = `Your barber account registration was not approved.${reason ? ' Reason: ' + reason : ''}`;
        await db.query(
            `INSERT INTO notifications (user_id, title, message, type) VALUES (?,?,?,?)`,
            [barberId, 'Account Not Approved', msg, 'alert']
        );

        return sendOk(res, `${barber.full_name} rejected.`, { id: Number(barberId) });
    } catch (err) {
        return serverError(res, 'REJECT', err);
    }
};

// POST /api/owner/barbers  (owner adds barber directly - auto approved)
const addBarber = async (req, res) => {
    try {
        const o = oid(req);
        const { full_name, email, password, phone, commission_rate, specialization, hire_date } = req.body;
        const branchId = targetBranchId(req);
        if (!full_name || !email || !password)
            return res.status(400).json({ success: false, message: 'Name, email, password required.' });
        if (!branchId)
            return res.status(400).json({ success: false, message: 'Branch is required.' });

        const [ex] = await db.query('SELECT id FROM users WHERE email=?', [email]);
        if (ex.length) return res.status(409).json({ success: false, message: 'Email already in use.' });

        const [[role]] = await db.query("SELECT id FROM roles WHERE name='barber'");
        if (!role) return res.status(500).json({ success: false, message: 'Barber role is missing.' });
        const hash     = await bcrypt.hash(password, 10);

        const [r] = await db.query(
            `INSERT INTO users (full_name,email,password,role_id,phone,is_active,status,owner_id,branch_id)
             VALUES (?,?,?,?,?,1,'approved',?,?)`,
            [full_name, email, hash, role.id, phone || null, o, branchId]
        );
        await db.query(
            'INSERT INTO barbers (user_id,commission_rate,specialization,hire_date) VALUES (?,?,?,?)',
            [r.insertId, commission_rate || 50, specialization || null, hire_date || null]
        );
        return sendOk(res, 'Barber added.', { id: r.insertId }, 201);
    } catch (err) {
        return serverError(res, 'ADD-BARBER', err);
    }
};

// PUT /api/owner/barbers/:id
const updateBarber = async (req, res) => {
    try {
        const o = oid(req);
        const { full_name, phone, commission_rate, specialization, hire_date, is_active, branch_id } = req.body;
        const branchId = targetBranchId(req);

        // Security: only update barbers belonging to this owner
        const [chk] = await db.query('SELECT id FROM users WHERE id=? AND owner_id=?', [req.params.id, o]);
        if (!chk.length) return res.status(403).json({ success: false, message: 'Access denied.' });

        await db.query(
            'UPDATE users SET full_name=?,phone=?,is_active=?,branch_id=COALESCE(?, branch_id) WHERE id=?',
            [full_name, phone || null, is_active !== undefined ? is_active : 1, branch_id || branchId, req.params.id]
        );
        await db.query(
            'UPDATE barbers SET commission_rate=?,specialization=?,hire_date=? WHERE user_id=?',
            [commission_rate || 50, specialization || null, hire_date || null, req.params.id]
        );
        return sendOk(res, 'Barber updated.', { id: Number(req.params.id) });
    } catch (err) {
        return serverError(res, 'ADD-INVENTORY', err);
    }
};

const getStaff = async (req, res) => {
    try {
        const o = oid(req);
        const p = [o];
        let sql = `
            SELECT u.id, u.full_name, u.email, u.phone, u.is_active, u.status,
                   u.branch_id, br.name AS branch_name, u.created_at
            FROM users u
            JOIN roles r ON u.role_id=r.id
            LEFT JOIN branches br ON u.branch_id=br.id
            WHERE r.name='staff' AND u.owner_id=?
        `;
        if (requestedBranchId(req)) {
            sql += ' AND u.branch_id=?';
            p.push(requestedBranchId(req));
        }
        sql += ' ORDER BY br.id ASC, u.full_name ASC';
        const [rows] = await db.query(sql, p);
        return sendData(res, rows);
    } catch (err) {
        return serverError(res, 'GET-STAFF', err);
    }
};

const addStaff = async (req, res) => {
    try {
        const o = oid(req);
        const branchId = targetBranchId(req);
        const { full_name, email, password, phone } = req.body;
        if (!full_name || !email || !password) {
            return res.status(400).json({ success: false, message: 'Name, email, password required.' });
        }
        if (!branchId) return res.status(400).json({ success: false, message: 'Branch is required.' });

        const [existing] = await db.query('SELECT id FROM users WHERE email=?', [email]);
        if (existing.length) return res.status(409).json({ success: false, message: 'Email already in use.' });

        const [[role]] = await db.query("SELECT id FROM roles WHERE name='staff' LIMIT 1");
        if (!role) return res.status(500).json({ success: false, message: 'Staff role is missing.' });

        const hash = await bcrypt.hash(password, 10);
        const [result] = await db.query(
            `INSERT INTO users (full_name,email,password,role_id,phone,is_active,status,owner_id,branch_id)
             VALUES (?,?,?,?,?,1,'approved',?,?)`,
            [full_name, email, hash, role.id, phone || null, o, branchId]
        );
        return sendOk(res, 'Staff account added.', { id: result.insertId }, 201);
    } catch (err) {
        return serverError(res, 'ADD-STAFF', err);
    }
};

const updateStaff = async (req, res) => {
    try {
        const o = oid(req);
        const { full_name, phone, is_active, branch_id } = req.body;
        const [check] = await db.query(
            `SELECT u.id FROM users u JOIN roles r ON u.role_id=r.id
             WHERE u.id=? AND u.owner_id=? AND r.name='staff'`,
            [req.params.id, o]
        );
        if (!check.length) return res.status(404).json({ success: false, message: 'Staff account not found.' });

        await db.query(
            `UPDATE users
             SET full_name=COALESCE(?, full_name),
                 phone=?,
                 is_active=?,
                 branch_id=COALESCE(?, branch_id)
             WHERE id=? AND owner_id=?`,
            [
                full_name || null,
                phone || null,
                is_active !== undefined ? is_active : 1,
                branch_id || null,
                req.params.id,
                o
            ]
        );
        return sendOk(res, 'Staff account updated.', { id: Number(req.params.id) });
    } catch (err) {
        return serverError(res, 'UPDATE-STAFF', err);
    }
};

// ============================================================
// INVENTORY  (all scoped by owner_id)
// ============================================================
const getInventory = async (req, res) => {
    try {
        const p = [oid(req)];
        const branchId = requestedBranchId(req);
        let sql = 'SELECT * FROM inventory WHERE owner_id=?';
        sql = appendBranchFilter(sql, p, 'branch_id', branchId);
        sql += ' ORDER BY category,name';
        const [rows] = await db.query(sql, p);
        return sendData(res, rows);
    } catch (err) {
        return serverError(res, 'RESTOCK-INVENTORY', err);
    }
};

const addInventoryItem = async (req, res) => {
    try {
        const o = oid(req);
        const branchId = targetBranchId(req);
        const { name, category, unit, quantity_in_stock, reorder_level, cost_per_unit, selling_price, supplier } = req.body;
        if (!name) return res.status(400).json({ success: false, message: 'Name required.' });
        if (!branchId) return res.status(400).json({ success: false, message: 'Branch is required.' });
        await db.query(
            `INSERT INTO inventory (owner_id,branch_id,name,category,unit,quantity_in_stock,reorder_level,cost_per_unit,selling_price,supplier)
             VALUES (?,?,?,?,?,?,?,?,?,?)`,
            [o, branchId, name, category || 'supplies', unit || 'pcs',
             quantity_in_stock || 0, reorder_level || 5, cost_per_unit || 0, selling_price || 0, supplier || null]
        );
        return sendOk(res, 'Item added.', {}, 201);
    } catch (err) {
        return serverError(res, 'ADD-EXPENSE', err);
    }
};

const updateInventoryItem = async (req, res) => {
    try {
        const o = oid(req);
        const { name, quantity_in_stock, reorder_level, cost_per_unit, selling_price, supplier, category, unit } = req.body;

        const [[current]] = await db.query(
            'SELECT * FROM inventory WHERE id=? AND owner_id=?',
            [req.params.id, o]
        );
        if (!current) return res.status(404).json({ success: false, message: 'Inventory item not found.' });

        await db.query(
            `UPDATE inventory SET name=?,category=?,unit=?,quantity_in_stock=?,reorder_level=?,
             cost_per_unit=?,selling_price=?,supplier=? WHERE id=? AND owner_id=?`,
            [
                name !== undefined ? name : current.name,
                category !== undefined ? category : current.category,
                unit !== undefined ? unit : current.unit,
                quantity_in_stock !== undefined ? quantity_in_stock : current.quantity_in_stock,
                reorder_level !== undefined ? reorder_level : current.reorder_level,
                cost_per_unit !== undefined ? cost_per_unit : current.cost_per_unit,
                selling_price !== undefined ? selling_price : current.selling_price,
                supplier !== undefined ? supplier : current.supplier,
                req.params.id,
                o
            ]
        );
        return sendOk(res, 'Item updated.', { id: Number(req.params.id) });
    } catch (err) {
        return serverError(res, 'UPDATE-INVENTORY', err);
    }
};

const restockItem = async (req, res) => {
    try {
        const o = oid(req);
        const { quantity_added, cost_total, supplier, notes } = req.body;
        if (!quantity_added) return res.status(400).json({ success: false, message: 'Quantity required.' });

        await db.query(
            'UPDATE inventory SET quantity_in_stock=quantity_in_stock+? WHERE id=? AND owner_id=?',
            [quantity_added, req.params.id, o]
        );
        await db.query(
            `INSERT INTO inventory_restocks (inventory_id,quantity_added,cost_total,supplier,restock_date,notes,added_by)
             VALUES (?,?,?,?,CURDATE(),?,?)`,
            [req.params.id, quantity_added, cost_total || 0, supplier || null, notes || null, req.user.id]
        );
        return sendOk(res, 'Stock updated.', { id: Number(req.params.id) });
    } catch (err) {
        return serverError(res, 'ADD-SERVICE', err);
    }
};

// ============================================================
// EXPENSES  (all scoped by owner_id)
// ============================================================
const getExpenses = async (req, res) => {
    try {
        const o = oid(req);
        const { date_from, date_to, category } = req.query;
        let sql  = `SELECT e.*, u.full_name AS recorded_by_name, br.name AS branch_name
                    FROM expenses e JOIN users u ON e.recorded_by=u.id
                    LEFT JOIN branches br ON e.branch_id=br.id
                    WHERE e.owner_id=?`;
        const p  = [o];

        if (date_from) { sql += ' AND e.expense_date>=?'; p.push(date_from); }
        if (date_to)   { sql += ' AND e.expense_date<=?'; p.push(date_to); }
        if (category)  { sql += ' AND e.category=?';      p.push(category); }
        if (requestedBranchId(req)) { sql += ' AND e.branch_id=?'; p.push(requestedBranchId(req)); }
        sql += ' ORDER BY e.expense_date DESC';

        const [rows] = await db.query(sql, p);
        return sendData(res, rows);
    } catch (err) {
        return serverError(res, 'GET-INVENTORY', err);
    }
};

const addExpense = async (req, res) => {
    try {
        const o = oid(req);
        const branchId = targetBranchId(req);
        const { title, category, amount, expense_date, paid_to, notes } = req.body;
        if (!title || !amount || !expense_date)
            return res.status(400).json({ success: false, message: 'Title, amount, date required.' });
        if (!branchId) return res.status(400).json({ success: false, message: 'Branch is required.' });

        await db.query(
            `INSERT INTO expenses (owner_id,branch_id,title,category,amount,expense_date,paid_to,notes,recorded_by)
             VALUES (?,?,?,?,?,?,?,?,?)`,
            [o, branchId, title, category || 'other', amount, expense_date, paid_to || null, notes || null, req.user.id]
        );
        return sendOk(res, 'Expense recorded.', {}, 201);
    } catch (err) {
        return serverError(res, 'GET-EXPENSES', err);
    }
};

const deleteExpense = async (req, res) => {
    try {
        const o = oid(req);
        await db.query('DELETE FROM expenses WHERE id=? AND owner_id=?', [req.params.id, o]);
        return sendOk(res, 'Expense deleted.', { id: Number(req.params.id) });
    } catch (err) {
        return serverError(res, 'GET-SERVICES', err);
    }
};

// ============================================================
// SERVICES  (scoped by owner_id)
// ============================================================
const getServices = async (req, res) => {
    try {
        const p = [oid(req)];
        let sql = `SELECT id, owner_id, branch_id, name, description, price,
                          duration_minutes, category, image_url, is_active, created_at
                   FROM services
                   WHERE owner_id=? AND is_active=1`;
        const branchId = requestedBranchId(req);
        if (branchId) {
            sql += ' AND (branch_id=? OR branch_id IS NULL)';
            p.push(branchId);
        }
        sql += ' ORDER BY name';
        const [rows] = await db.query(sql, p);
        return sendData(res, toServiceResources(rows));
    } catch (err) {
        return serverError(res, 'GET-SERVICES', err);
    }
};

const addService = async (req, res) => {
    try {
        const o = oid(req);
        const branchId = targetBranchId(req);
        const { name, description, price, duration_minutes, category } = req.body;
        if (!name || !price) return res.status(400).json({ success: false, message: 'Name and price required.' });
        if (!branchId) return res.status(400).json({ success: false, message: 'Branch is required.' });
        const imageUrl = await saveServiceImage(req.body);
        const [result] = await db.query(
            'INSERT INTO services (owner_id,branch_id,name,description,price,duration_minutes,category,image_url) VALUES (?,?,?,?,?,?,?,?)',
            [o, branchId, name, description || null, price, duration_minutes || 30, category || null, imageUrl || null]
        );
        const [[service]] = await db.query(
            `SELECT id, owner_id, branch_id, name, description, price,
                    duration_minutes, category, image_url, is_active, created_at
             FROM services WHERE id=? AND owner_id=?`,
            [result.insertId, o]
        );
        return sendOk(res, 'Service added.', [toServiceResource(service)], 201);
    } catch (err) {
        if (err.statusCode) return res.status(err.statusCode).json({ success: false, message: err.message });
        return serverError(res, 'ADD-SERVICE', err);
    }
};

const updateService = async (req, res) => {
    try {
        const o = oid(req);
        const { name, description, price, duration_minutes, category, is_active, branch_id } = req.body;

        const [[current]] = await db.query(
            'SELECT * FROM services WHERE id=? AND owner_id=?',
            [req.params.id, o]
        );
        if (!current) return res.status(404).json({ success: false, message: 'Service not found.' });

        const imageUrl = await saveServiceImage(req.body, current.image_url);

        await db.query(
            `UPDATE services SET name=?,description=?,price=?,duration_minutes=?,category=?,image_url=?,is_active=?,branch_id=?
             WHERE id=? AND owner_id=?`,
            [
                name !== undefined ? name : current.name,
                description !== undefined ? description : current.description,
                price !== undefined ? price : current.price,
                duration_minutes !== undefined ? duration_minutes : current.duration_minutes,
                category !== undefined ? category : current.category,
                imageUrl,
                is_active !== undefined ? is_active : current.is_active,
                branch_id !== undefined && branch_id !== '' ? branch_id : current.branch_id,
                req.params.id,
                o
            ]
        );
        const [[service]] = await db.query(
            `SELECT id, owner_id, branch_id, name, description, price,
                    duration_minutes, category, image_url, is_active, created_at
             FROM services WHERE id=? AND owner_id=?`,
            [req.params.id, o]
        );
        return sendOk(res, 'Service updated.', [toServiceResource(service)]);
    } catch (err) {
        if (err.statusCode) return res.status(err.statusCode).json({ success: false, message: err.message });
        return serverError(res, 'UPDATE-SERVICE', err);
    }
};

const deleteService = async (req, res) => {
    try {
        const o = oid(req);
        const [[current]] = await db.query(
            'SELECT id FROM services WHERE id=? AND owner_id=? AND is_active=1',
            [req.params.id, o]
        );
        if (!current) return res.status(404).json({ success: false, message: 'Service not found.' });

        await db.query(
            'UPDATE services SET is_active=0 WHERE id=? AND owner_id=?',
            [req.params.id, o]
        );
        return sendOk(res, 'Service deleted.', []);
    } catch (err) {
        return serverError(res, 'DELETE-SERVICE', err);
    }
};

// ============================================================
// MONTHLY REPORT  GET /api/owner/report?month=YYYY-MM
// ============================================================
const getMonthlyReport = async (req, res) => {
    try {
        const o         = oid(req);
        const branchId  = requestedBranchId(req);
        const branchSql = branchId ? ' AND branch_id=?' : '';
        const month     = req.query.month || new Date().toISOString().slice(0, 7);
        const start     = `${month}-01`;
        const end       = new Date(
            new Date(start).getFullYear(),
            new Date(start).getMonth() + 1, 0
        ).toISOString().split('T')[0];

        const [[sal]] = await db.query(
            `SELECT COALESCE(SUM(amount),0) AS total_revenue,
                    COALESCE(SUM(commission_amount),0) AS total_commission,
                    COUNT(*) AS total_transactions
             FROM sales WHERE owner_id=? AND sale_date BETWEEN ? AND ?${branchSql}`,
            branchId ? [o, start, end, branchId] : [o, start, end]
        );
        const [[exp]] = await db.query(
            `SELECT COALESCE(SUM(amount),0) AS total_expenses FROM expenses WHERE owner_id=? AND expense_date BETWEEN ? AND ?${branchSql}`,
            branchId ? [o, start, end, branchId] : [o, start, end]
        );
        const salesBranchSql = branchId ? ' AND s.branch_id=?' : '';
        const [topBarbers] = await db.query(
            `SELECT u.full_name, b.commission_rate, SUM(s.amount) AS revenue, COUNT(s.id) AS customers
             FROM sales s JOIN users u ON s.barber_id=u.id JOIN barbers b ON b.user_id=u.id
             WHERE s.owner_id=? AND s.sale_date BETWEEN ? AND ?${salesBranchSql}
             GROUP BY s.barber_id ORDER BY revenue DESC`,
            branchId ? [o, start, end, branchId] : [o, start, end]
        );
        const [topServices] = await db.query(
            `SELECT sv.name, COUNT(s.id) AS count, SUM(s.amount) AS revenue
             FROM sales s JOIN services sv ON s.service_id=sv.id
             WHERE s.owner_id=? AND s.sale_date BETWEEN ? AND ?${salesBranchSql}
             GROUP BY s.service_id ORDER BY count DESC`,
            branchId ? [o, start, end, branchId] : [o, start, end]
        );

        const report = {
                period:       { start, end },
                revenue:      parseFloat(sal.total_revenue),
                total_sales:  parseFloat(sal.total_revenue),
                commission:   parseFloat(sal.total_commission),
                transactions: sal.total_transactions,
                expenses:     parseFloat(exp.total_expenses),
                total_expenses: parseFloat(exp.total_expenses),
                net_profit:   parseFloat(sal.total_revenue) - parseFloat(exp.total_expenses),
                top_barbers:  topBarbers,
                top_services: topServices
            };

        return sendData(res, report, { report });
    } catch (err) {
        return serverError(res, 'REPORT', err);
    }
};

// ============================================================
// NOTIFICATIONS  (scoped by user_id = this owner)
// ============================================================
const getNotifications = async (req, res) => {
    try {
        const [rows] = await db.query(
            'SELECT * FROM notifications WHERE user_id=? ORDER BY created_at DESC LIMIT 30',
            [req.user.id]
        );
        return sendData(res, rows);
    } catch (err) {
        return serverError(res, 'GET-NOTIFICATIONS', err);
    }
};

const markNotificationRead = async (req, res) => {
    try {
        await db.query(
            'UPDATE notifications SET is_read=1 WHERE id=? AND user_id=?',
            [req.params.id, req.user.id]
        );
        return sendData(res, { id: Number(req.params.id), is_read: 1 });
    } catch (err) {
        return serverError(res, 'MARK-NOTIFICATION', err);
    }
};

module.exports = {
    getBranches,
    getDashboardStats, getSalesChart, getBarberPerformance,
    getSales, addSale, deleteSale,
    getBarbers, getPendingBarbers, approveBarber, rejectBarber, addBarber, updateBarber,
    getStaff, addStaff, updateStaff,
    getInventory, addInventoryItem, updateInventoryItem, restockItem,
    getExpenses, addExpense, deleteExpense,
    getServices, addService, updateService, deleteService,
    getMonthlyReport,
    getNotifications, markNotificationRead
};
