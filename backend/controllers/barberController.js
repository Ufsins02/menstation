// ============================================================
// backend/controllers/barberController.js
// v3: Branch-scoped. Read-only for barbers.
//     No direct sale creation - handled by staff.
// ============================================================

const db = require('../config/db');
const { normalizeBranchId } = require('../utils/branchFilter');
const { toServiceResources } = require('../utils/servicePresenter');
const logger = require('../utils/logger');

const cleanText = (value) => {
    if (value === undefined) return undefined;
    const trimmed = String(value || '').trim();
    return trimmed || null;
};

const isAllowedImageValue = (value) => {
    if (!value) return true;
    return /^https?:\/\/\S+/i.test(value) || /^data:image\/(png|jpe?g|webp|gif);base64,/i.test(value);
};

const toIntOrNull = normalizeBranchId;

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

const attachWorksToBarbers = async (barbers) => {
    if (!barbers.length) return barbers;
    const ids = barbers.map(b => b.id);
    const [works] = await db.query(
        `SELECT id, barber_id, image_url, created_at
         FROM barber_works
         WHERE barber_id IN (?)
         ORDER BY created_at DESC, id DESC`,
        [ids]
    ).catch(() => [[]]);

    const byBarber = works.reduce((map, work) => {
        if (!map[work.barber_id]) map[work.barber_id] = [];
        map[work.barber_id].push(work);
        return map;
    }, {});

    return barbers.map(barber => ({
        ...barber,
        gallery: byBarber[barber.id] || []
    }));
};

const attachVariantsToServices = async (services) => {
    if (!services.length) return services;
    const ids = services.map(s => s.id);
    const [variants] = await db.query(
        `SELECT id, service_id, name, image_url
         FROM service_variants
         WHERE service_id IN (?)
         ORDER BY id ASC`,
        [ids]
    ).catch(() => [[]]);

    const byService = variants.reduce((map, item) => {
        if (!map[item.service_id]) map[item.service_id] = [];
        map[item.service_id].push(item);
        return map;
    }, {});

    return services.map(service => ({
        ...service,
        variants: byService[service.id] || []
    }));
};

const getActiveBranches = async () => {
    const [branches] = await db.query(
        `SELECT id, name, location AS address, phone,
                hours_weekday, hours_weekend, created_at
         FROM branches
         WHERE is_active=1
         ORDER BY id ASC`
    );
    return branches;
};

const getBranchInfo = async (branchId) => {
    const [[branch]] = await db.query(
        `SELECT id, name, location AS address, phone,
                hours_weekday, hours_weekend, created_at
         FROM branches
         WHERE id=? AND is_active=1
         LIMIT 1`,
        [branchId]
    );
    return branch;
};

// ── Helper: resolve owner_id for barber ─────────────────────
const getOwnerForBarber = async (userId) => {
    const [[u]] = await db.query('SELECT owner_id, branch_id FROM users WHERE id=?', [userId]);
    return u || { owner_id: null, branch_id: null };
};

// ============================================================
// STATS  GET /api/barber/stats
// ============================================================
const getMyStats = async (req, res) => {
    try {
        const id       = req.user.id;
        const bid      = req.user.branch_id;
        const today    = new Date().toISOString().split('T')[0];
        const firstDay = today.slice(0, 8) + '01';

        const [[todayE]] = await db.query(
            `SELECT COALESCE(SUM(commission_amount),0) AS earnings, COUNT(*) AS customers
             FROM sales WHERE barber_id=? AND branch_id=? AND sale_date=?`,
            [id, bid, today]
        );
        const [[monthE]] = await db.query(
            `SELECT COALESCE(SUM(commission_amount),0) AS earnings,
                    COUNT(*) AS customers,
                    COALESCE(SUM(amount),0) AS total_sales
             FROM sales WHERE barber_id=? AND branch_id=? AND sale_date>=?`,
            [id, bid, firstDay]
        );
        const [[bInfo]] = await db.query(
            'SELECT commission_rate FROM barbers WHERE user_id=?', [id]
        );
        const [[todayRes]] = await db.query(
            "SELECT COUNT(*) AS c FROM reservations WHERE barber_id=? AND branch_id=? AND res_date=? AND status IN ('pending','confirmed','in_progress')",
            [id, bid, today]
        );

        return res.json({
            success: true,
            stats: {
                today_earnings:       parseFloat(todayE.earnings),
                today_customers:      todayE.customers,
                today_reservations:   todayRes.c,
                monthly_earnings:     parseFloat(monthE.earnings),
                monthly_customers:    monthE.customers,
                monthly_sales_total:  parseFloat(monthE.total_sales),
                commission_rate:      bInfo ? bInfo.commission_rate : 50
            }
        });
    } catch (err) {
        logger.error('[BARBER-STATS]', err.message);
        return res.status(500).json({ success: false, message: 'Server error.' });
    }
};

// ============================================================
// MY RESERVATIONS  GET /api/barber/reservations
// Only this barber's bookings in their branch
// ============================================================
const getMyReservations = async (req, res) => {
    try {
        const { date, status } = req.query;
        const today = new Date().toISOString().split('T')[0];

        let sql = `
            SELECT r.id, r.customer_name, r.customer_phone,
                   r.res_date, r.res_time, r.duration_min,
                   r.status, r.notes, r.sale_id,
                   s.id AS primary_service_id, s.name AS primary_service_name,
                   s.price AS primary_service_price,
                   GROUP_CONCAT(CONCAT(svc.id, '::', REPLACE(svc.name, '::', ' '), '::', rs.price, '::', rs.duration_minutes) ORDER BY rs.id SEPARATOR '||') AS services_blob,
                   b.name  AS branch_name
            FROM reservations r
            JOIN services s ON r.service_id = s.id
            JOIN branches b ON r.branch_id  = b.id
            LEFT JOIN reservation_services rs ON rs.reservation_id = r.id
            LEFT JOIN services svc ON svc.id = rs.service_id
            WHERE r.barber_id = ? AND r.branch_id = ?
        `;
        const params = [req.user.id, req.user.branch_id];

        // Default to today's reservations
        sql += ' AND r.res_date = ?';
        params.push(date || today);

        if (status) { sql += ' AND r.status = ?'; params.push(status); }

        sql += ` GROUP BY r.id, r.customer_name, r.customer_phone, r.res_date, r.res_time,
                  r.duration_min, r.status, r.notes, r.sale_id, s.id, s.name, s.price, b.name
                 ORDER BY r.res_time ASC`;

        const [rows] = await db.query(sql, params);
        return res.json({ success: true, data: shapeReservationRows(rows) });
    } catch (err) {
        logger.error('[BARBER-RESERVATIONS]', err.message);
        return res.status(500).json({ success: false, message: 'Server error.' });
    }
};

// ============================================================
// SALES HISTORY  GET /api/barber/sales  (read-only)
// ============================================================
const getMySales = async (req, res) => {
    try {
        const { date_from, date_to } = req.query;

        let sql = `
            SELECT s.id, s.customer_name, s.amount, s.commission_amount,
                   s.payment_method, s.sale_date, s.notes,
                   sv.name AS service_name
            FROM sales s
            JOIN services sv ON s.service_id = sv.id
            WHERE s.barber_id = ? AND s.branch_id = ?
        `;
        const p = [req.user.id, req.user.branch_id];

        if (date_from) { sql += ' AND s.sale_date>=?'; p.push(date_from); }
        if (date_to)   { sql += ' AND s.sale_date<=?'; p.push(date_to); }
        sql += ' ORDER BY s.sale_date DESC, s.created_at DESC LIMIT 150';

        const [rows] = await db.query(sql, p);
        return res.json({ success: true, data: rows });
    } catch (err) {
        return res.status(500).json({ success: false, message: 'Server error.' });
    }
};

// ============================================================
// WEEKLY COMMISSION CHART  GET /api/barber/weekly-chart
// ============================================================
const getMyWeeklyChart = async (req, res) => {
    try {
        const [rows] = await db.query(`
            SELECT DATE_FORMAT(sale_date,'%a') AS day,
                   sale_date,
                   SUM(commission_amount) AS earnings,
                   COUNT(*) AS customers
            FROM sales
            WHERE barber_id=? AND branch_id=? AND sale_date >= DATE_SUB(CURDATE(), INTERVAL 6 DAY)
            GROUP BY sale_date
            ORDER BY sale_date ASC
        `, [req.user.id, req.user.branch_id]);
        return res.json({ success: true, data: rows });
    } catch (err) {
        return res.status(500).json({ success: false, message: 'Server error.' });
    }
};

// ============================================================
// SERVICES LIST  GET /api/barber/services
// Returns this barber's branch services (read-only)
// ============================================================
const getServices = async (req, res) => {
    try {
        if (!req.user.branch_id) return res.json({ success: true, data: [] });

        const [rows] = await db.query(
            `SELECT id, name, price, duration_minutes, category, image_url
             FROM services
             WHERE is_active=1 AND (branch_id=? OR branch_id IS NULL)
             ORDER BY name`,
            [req.user.branch_id]
        );
        return res.json({ success: true, data: toServiceResources(rows) });
    } catch (err) {
        return res.status(500).json({ success: false, message: 'Server error.' });
    }
};

// ============================================================
// MY PROFILE  GET /api/barber/profile
// ============================================================
const getMyProfile = async (req, res) => {
    try {
        const [rows] = await db.query(`
            SELECT u.id, u.full_name, u.email, u.phone, u.profile_photo,
                   u.created_at, u.branch_id,
                   b.name AS branch_name,
                   br.commission_rate, br.specialization, br.hire_date, br.bio, br.nickname
            FROM users u
            JOIN barbers  br ON br.user_id  = u.id
            LEFT JOIN branches b ON u.branch_id = b.id
            WHERE u.id=?
        `, [req.user.id]);

        if (!rows.length) return res.status(404).json({ success: false, message: 'Profile not found.' });
        return res.json({ success: true, data: rows[0] });
    } catch (err) {
        return res.status(500).json({ success: false, message: 'Server error.' });
    }
};

// ============================================================
// UPDATE MY PROFILE  PUT /api/barber/profile
// ============================================================
const updateMyProfile = async (req, res) => {
    try {
        const id = req.user.id;
        const {
            full_name,
            nickname,
            specialization,
            bio,
            profile_photo
        } = req.body;

        if (profile_photo !== undefined && !isAllowedImageValue(profile_photo)) {
            return res.status(400).json({ success: false, message: 'Profile photo must be an image URL or image file data.' });
        }

        const [[current]] = await db.query(`
            SELECT u.full_name, u.profile_photo, b.nickname, b.specialization, b.bio
            FROM users u
            JOIN barbers b ON b.user_id = u.id
            WHERE u.id=?
        `, [id]);
        if (!current) return res.status(404).json({ success: false, message: 'Profile not found.' });

        const nextName = full_name !== undefined ? cleanText(full_name) : current.full_name;
        if (!nextName) {
            return res.status(400).json({ success: false, message: 'Full name is required.' });
        }

        await db.query(
            `UPDATE users
             SET full_name=?, profile_photo=?
             WHERE id=?`,
            [
                nextName,
                profile_photo !== undefined ? cleanText(profile_photo) : current.profile_photo,
                id
            ]
        );

        await db.query(
            `UPDATE barbers
             SET nickname=?, specialization=?, bio=?
             WHERE user_id=?`,
            [
                nickname !== undefined ? cleanText(nickname) : current.nickname,
                specialization !== undefined ? cleanText(specialization) : current.specialization,
                bio !== undefined ? cleanText(bio) : current.bio,
                id
            ]
        );

        const [rows] = await db.query(`
            SELECT u.id, u.full_name, u.email, u.phone, u.profile_photo,
                   u.created_at, u.branch_id,
                   b.name AS branch_name,
                   br.commission_rate, br.specialization, br.hire_date, br.bio, br.nickname
            FROM users u
            JOIN barbers  br ON br.user_id  = u.id
            LEFT JOIN branches b ON u.branch_id = b.id
            WHERE u.id=?
        `, [id]);

        return res.json({ success: true, message: 'Profile updated.', data: rows[0] });
    } catch (err) {
        logger.error('[BARBER-UPDATE-PROFILE]', err.message);
        return res.status(500).json({ success: false, message: 'Server error.' });
    }
};

// ============================================================
// ADD WORK IMAGE  POST /api/barber/work-images
// ============================================================
const addWorkImage = async (req, res) => {
    try {
        const imageUrl = cleanText(req.body.image_url);
        if (!imageUrl) {
            return res.status(400).json({ success: false, message: 'image_url is required.' });
        }
        if (!isAllowedImageValue(imageUrl)) {
            return res.status(400).json({ success: false, message: 'Work image must be an image URL or image file data.' });
        }

        const [result] = await db.query(
            'INSERT INTO barber_works (barber_id, image_url) VALUES (?, ?)',
            [req.user.id, imageUrl]
        );

        return res.status(201).json({
            success: true,
            message: 'Work image added.',
            data: { id: result.insertId, barber_id: req.user.id, image_url: imageUrl }
        });
    } catch (err) {
        logger.error('[BARBER-ADD-WORK]', err.message);
        return res.status(500).json({ success: false, message: 'Server error.' });
    }
};

// ============================================================
// PUBLIC WORK IMAGES  GET /api/barber/work-images/:barber_id
// ============================================================
const getWorkImagesByBarber = async (req, res) => {
    try {
        const [rows] = await db.query(
            `SELECT id, barber_id, image_url, created_at
             FROM barber_works
             WHERE barber_id=?
             ORDER BY created_at DESC, id DESC`,
            [req.params.barber_id]
        );
        return res.json({ success: true, data: rows });
    } catch (err) {
        logger.error('[BARBER-PUBLIC-WORKS]', err.message);
        return res.status(500).json({ success: false, message: 'Server error.' });
    }
};

// ============================================================
// DELETE WORK IMAGE  DELETE /api/barber/work-images/:id
// ============================================================
const deleteWorkImage = async (req, res) => {
    try {
        const [[work]] = await db.query(
            'SELECT id, barber_id FROM barber_works WHERE id=? LIMIT 1',
            [req.params.id]
        );
        if (!work) return res.status(404).json({ success: false, message: 'Work image not found.' });

        const isAdmin = ['admin', 'owner'].includes(req.user.role);
        const isOwnWork = Number(work.barber_id) === Number(req.user.id);
        if (!isAdmin && !isOwnWork) {
            return res.status(403).json({ success: false, message: 'You can only delete your own work images.' });
        }

        await db.query('DELETE FROM barber_works WHERE id=?', [req.params.id]);
        return res.json({ success: true, message: 'Work image deleted.' });
    } catch (err) {
        logger.error('[BARBER-DELETE-WORK]', err.message);
        return res.status(500).json({ success: false, message: 'Server error.' });
    }
};

// ============================================================
// PUBLIC BARBERS  GET /api/public/barbers
// ============================================================
const getPublicBarbers = async (req, res) => {
    try {
        const branchId = toIntOrNull(req.query.branch_id);
        let sql = `
            SELECT u.id, u.full_name, u.profile_photo, b.specialization, b.bio,
                   b.nickname, b.is_featured, u.branch_id, br.name AS branch_name
            FROM users u
            JOIN barbers b ON b.user_id=u.id
            JOIN roles  r ON u.role_id=r.id
            LEFT JOIN branches br ON u.branch_id=br.id
            WHERE r.name='barber' AND u.is_active=1 AND u.status='approved'
        `;
        const params = [];
        if (branchId) {
            sql += ' AND u.branch_id=?';
            params.push(branchId);
        }
        sql += ' ORDER BY br.id ASC, b.is_featured DESC, u.full_name ASC';
        const [barbers] = await db.query(sql, params);

        return res.json({ success: true, data: await attachWorksToBarbers(barbers) });
    } catch (err) {
        logger.error('[PUBLIC-BARBERS]', err.message);
        return res.status(500).json({ success: false, message: 'Server error.' });
    }
};

// ============================================================
// PUBLIC BRANCHES  GET /api/public/branches
// ============================================================
const getPublicBranches = async (req, res) => {
    try {
        const branches = await getActiveBranches();
        return res.json({ success: true, data: branches });
    } catch (err) {
        logger.error('[PUBLIC-BRANCHES]', err.message);
        return res.status(500).json({ success: false, message: 'Server error.' });
    }
};

// ============================================================
// PUBLIC SERVICES  GET /api/public/services  (no auth)
// Source: database services table only.
// ============================================================
const getPublicServices = async (req, res) => {
    try {
        const branchId = toIntOrNull(req.query.branch_id);
        const includeImage = String(req.query.view || '').toLowerCase() !== 'reservation';

        let sql = `SELECT id, name, description, price, duration_minutes, category, image_url, branch_id
                   FROM services
                   WHERE is_active=1`;
        const params = [];
        if (branchId) {
            sql += ' AND (branch_id=? OR branch_id IS NULL)';
            params.push(branchId);
        }
        sql += ' ORDER BY name';

        const [rows] = await db.query(sql, params);
        return res.json({
            success: true,
            data: toServiceResources(rows, { includeImage, includeInternal: true })
        });
    } catch (err) {
        logger.error('[PUBLIC-SERVICES]', err.message);
        return res.status(500).json({ success: false, message: 'Server error.' });
    }
};

// ============================================================
// PUBLIC BRANCH DETAIL  GET /api/public/branch/:id
// ============================================================
const getPublicBranch = async (req, res) => {
    try {
        const branchId = toIntOrNull(req.params.id);
        if (!branchId) return res.status(400).json({ success: false, message: 'Invalid branch id.' });

        const branch = await getBranchInfo(branchId);
        if (!branch) return res.status(404).json({ success: false, message: 'Branch not found.' });

        const [services] = await db.query(
            `SELECT id, name, description, price, duration_minutes, category, image_url, branch_id
             FROM services
             WHERE is_active=1 AND (branch_id=? OR branch_id IS NULL)
              ORDER BY name`,
            [branchId]
        );
        const [barbers] = await db.query(`
            SELECT u.id, u.full_name, u.profile_photo, b.specialization, b.bio,
                   b.nickname, b.is_featured, u.branch_id, br.name AS branch_name
            FROM users u
            JOIN barbers b ON b.user_id=u.id
            JOIN roles  r ON u.role_id=r.id
            LEFT JOIN branches br ON u.branch_id=br.id
            WHERE r.name='barber'
              AND u.is_active=1
              AND u.status='approved'
              AND u.branch_id=?
            ORDER BY b.is_featured DESC, u.full_name ASC
        `, [branchId]);

        const payload = {
            branch,
            services: await attachVariantsToServices(toServiceResources(services)),
            barbers: await attachWorksToBarbers(barbers)
        };

        return res.json({
            success: true,
            data: payload,
            ...payload
        });
    } catch (err) {
        logger.error('[PUBLIC-BRANCH]', err.message);
        return res.status(500).json({ success: false, message: 'Server error.' });
    }
};

// ============================================================
// PUBLIC INFO  GET /api/public/info  (no auth)
// ============================================================
const getPublicInfo = async (req, res) => {
    try {
        const branches = await getActiveBranches();
        const branchId = toIntOrNull(req.query.branch_id);
        const selectedBranch = branchId
            ? branches.find(b => Number(b.id) === Number(branchId))
            : null;

        const [profiles] = await db.query('SELECT * FROM shop_profiles LIMIT 1').catch(() => [[]]);
        let shopInfo = {};

        if (profiles.length) {
            const p = profiles[0];
            shopInfo = {
                shop_name:          p.shop_name,
                shop_tagline:       p.tagline,
                shop_address:       p.address,
                shop_phone:         p.phone,
                shop_email:         p.email,
                shop_facebook:      p.facebook,
                shop_instagram:     p.instagram,
                shop_hours_weekday: p.hours_weekday,
                shop_hours_weekend: p.hours_weekend,
                about_text:         p.about_text
            };
        } else {
            const [settings] = await db.query('SELECT setting_key, setting_value FROM shop_settings').catch(() => [[]]);
            settings.forEach(s => { shopInfo[s.setting_key] = s.setting_value; });
        }

        if (selectedBranch) {
            shopInfo.branch_id = selectedBranch.id;
            shopInfo.branch_name = selectedBranch.name;
            shopInfo.shop_address = selectedBranch.address || shopInfo.shop_address;
            shopInfo.shop_phone = selectedBranch.phone || shopInfo.shop_phone;
            shopInfo.shop_hours_weekday = selectedBranch.hours_weekday || shopInfo.shop_hours_weekday;
            shopInfo.shop_hours_weekend = selectedBranch.hours_weekend || shopInfo.shop_hours_weekend;
        }

        let serviceSql = `SELECT id, name, description, price, duration_minutes, category, image_url, branch_id
             FROM services
             WHERE is_active=1`;
        const serviceParams = [];
        if (selectedBranch) {
            serviceSql += ' AND (branch_id=? OR branch_id IS NULL)';
            serviceParams.push(selectedBranch.id);
        }
        serviceSql += ' ORDER BY name';
        const [services] = await db.query(serviceSql, serviceParams);

        let barberSql = `
            SELECT u.id, u.full_name, u.profile_photo, b.specialization, b.bio,
                   b.nickname, b.is_featured, u.branch_id, br.name AS branch_name
            FROM users u
            JOIN barbers b ON b.user_id=u.id
            JOIN roles  r ON u.role_id=r.id
            LEFT JOIN branches br ON u.branch_id=br.id
            WHERE r.name='barber' AND u.is_active=1 AND u.status='approved'
        `;
        const barberParams = [];
        if (selectedBranch) {
            barberSql += ' AND u.branch_id=?';
            barberParams.push(selectedBranch.id);
        }
        barberSql += ' ORDER BY br.id ASC, b.is_featured DESC, u.full_name ASC';
        const [barbers] = await db.query(barberSql, barberParams);

        const payload = {
            branches,
            branch: selectedBranch || null,
            shop: shopInfo,
            services: await attachVariantsToServices(toServiceResources(services)),
            barbers: await attachWorksToBarbers(barbers)
        };

        return res.json({
            success: true,
            data: payload,
            ...payload
        });
    } catch (err) {
        logger.error('[PUBLIC-INFO]', err.message);
        return res.status(500).json({ success: false, message: 'Server error.' });
    }
};

module.exports = {
    getMyStats, getMyReservations, getMySales, getMyWeeklyChart,
    getServices, getMyProfile, updateMyProfile,
    addWorkImage, getWorkImagesByBarber, deleteWorkImage,
    getPublicBarbers, getPublicBranches, getPublicBranch, getPublicServices, getPublicInfo
};
