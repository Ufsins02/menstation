const db = require('../config/db');
const { normalizeBranchId } = require('../utils/branchFilter');
const logger = require('../utils/logger');

const VALID_STATUS = ['pending', 'confirmed', 'in_progress', 'done', 'cancelled'];

const isDate = (value) => /^\d{4}-\d{2}-\d{2}$/.test(String(value || ''));
const isTime = (value) => /^([01]\d|2[0-3]):[0-5]\d(:[0-5]\d)?$/.test(String(value || ''));
const toTime = (value) => String(value).length === 5 ? `${value}:00` : String(value);
const toIntOrNull = normalizeBranchId;

const normalizeServiceIds = ({ service_id, service_ids }) => {
    const raw = Array.isArray(service_ids)
        ? service_ids
        : service_ids !== undefined && service_ids !== null && service_ids !== ''
            ? String(service_ids).split(',')
            : [service_id];

    return [...new Set(raw.map(toIntOrNull).filter(Boolean))];
};

const scopedWhere = (req, params) => {
    const where = [];

    if (req.user.role === 'barber') {
        where.push('r.barber_id=?');
        params.push(req.user.id);
    } else if (req.branchFilter) {
        where.push('r.branch_id=?');
        params.push(req.branchFilter);
    } else if (req.user.role === 'admin') {
        where.push('r.owner_id=?');
        params.push(req.user.owner_id || req.user.id);
    } else {
        where.push('r.branch_id=?');
        params.push(req.user.branch_id);
    }

    return where;
};

const getBookingContext = async (serviceIds, barberId) => {
    const placeholders = serviceIds.map(() => '?').join(',');
    const [rows] = await db.query(
        `SELECT s.id AS service_id, s.name AS service_name, s.price,
                s.duration_minutes, s.branch_id AS service_branch_id,
                COALESCE(s.owner_id, u.owner_id, u.id) AS owner_id,
                u.branch_id, u.id AS barber_id, u.full_name AS barber_name
         FROM users u
         JOIN roles r ON u.role_id=r.id
         JOIN services s
           ON s.id IN (${placeholders})
          AND s.is_active=1
          AND (s.branch_id=u.branch_id OR s.branch_id IS NULL)
         WHERE u.id=?
           AND r.name='barber'
           AND u.is_active=1
           AND u.status='approved'
         ORDER BY FIELD(s.id, ${placeholders})`,
        [...serviceIds, barberId, ...serviceIds]
    );

    if (rows.length !== serviceIds.length) return null;

    const totalPrice = rows.reduce((sum, s) => sum + parseFloat(s.price || 0), 0);
    const totalDuration = rows.reduce((sum, s) => sum + parseInt(s.duration_minutes || 30, 10), 0);

    return {
        ...rows[0],
        service_id: rows[0].service_id,
        service_name: rows.map(s => s.service_name).join(', '),
        price: totalPrice,
        duration_minutes: totalDuration,
        services: rows.map(s => ({
            id: s.service_id,
            name: s.service_name,
            price: parseFloat(s.price || 0),
            duration_minutes: parseInt(s.duration_minutes || 30, 10)
        }))
    };
};

const reservationExists = async (barberId, date, time, excludeId = null) => {
    let sql = `
        SELECT id FROM reservations
        WHERE barber_id=? AND res_date=? AND res_time=?
          AND status NOT IN ('done','cancelled')
    `;
    const params = [barberId, date, time];

    if (excludeId) {
        sql += ' AND id<>?';
        params.push(excludeId);
    }

    sql += ' LIMIT 1';
    const [rows] = await db.query(sql, params);
    return rows.length > 0;
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

const insertReservation = async ({ customer_name, customer_phone, service_id, service_ids, barber_id, branch_id, date, time, notes, created_by }) => {
    if (!customer_name || !customer_name.trim()) {
        return { error: { code: 400, message: 'Customer name is required.' } };
    }
    const serviceIds = normalizeServiceIds({ service_id, service_ids });
    if (!serviceIds.length || !barber_id || !date || !time) {
        return { error: { code: 400, message: 'service_ids, barber_id, date, and time are required.' } };
    }
    if (!isDate(date) || !isTime(time)) {
        return { error: { code: 400, message: 'Invalid reservation date or time.' } };
    }

    const resTime = toTime(time);
    const context = await getBookingContext(serviceIds, barber_id);
    if (!context) {
        return { error: { code: 404, message: 'Selected service or barber is unavailable for this branch.' } };
    }
    const requestedBranchId = toIntOrNull(branch_id);
    if (requestedBranchId && Number(context.branch_id) !== Number(requestedBranchId)) {
        return { error: { code: 400, message: 'Selected barber is not available in that branch.' } };
    }

    if (await reservationExists(context.barber_id, date, resTime)) {
        return { error: { code: 409, message: 'That barber already has a reservation at this time.' } };
    }

    const createdBy = created_by || context.owner_id || context.barber_id;
    const conn = await db.getConnection();
    let result;
    try {
        await conn.beginTransaction();
        [result] = await conn.query(
            `INSERT INTO reservations
             (customer_name, customer_phone, service_id, barber_id, branch_id, owner_id,
              res_date, res_time, duration_min, notes, status, created_by)
             VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
            [
                customer_name.trim(),
                customer_phone || null,
                context.service_id,
                context.barber_id,
                context.branch_id,
                context.owner_id,
                date,
                resTime,
                context.duration_minutes || 30,
                notes || null,
                'pending',
                createdBy
            ]
        );

        const values = context.services.map(svc => [
            result.insertId,
            svc.id,
            svc.price,
            svc.duration_minutes
        ]);
        await conn.query(
            'INSERT INTO reservation_services (reservation_id, service_id, price, duration_minutes) VALUES ?',
            [values]
        );
        await conn.commit();
    } catch (err) {
        await conn.rollback();
        throw err;
    } finally {
        conn.release();
    }

    return {
        reservation_id: result.insertId,
        ticket_number: `MS-${String(result.insertId).padStart(5, '0')}`,
        context,
        reservation: {
            id: result.insertId,
            ticket_number: `MS-${String(result.insertId).padStart(5, '0')}`,
            customer_name: customer_name.trim(),
            customer_phone: customer_phone || null,
            branch_id: context.branch_id,
            barber_id: context.barber_id,
            barber_name: context.barber_name,
            services: context.services,
            service_ids: context.services.map(svc => svc.id),
            service_name: context.service_name,
            service_price: context.price,
            duration_min: context.duration_minutes,
            res_date: date,
            res_time: resTime,
            payment_note: 'Walk-in payment only',
            reminder: 'Arriving late in reserved hours will be cancelled.'
        }
    };
};

const getReservations = async (req, res) => {
    try {
        const { date, status, barber_id, branch_id } = req.query;
        const params = [];
        const where = scopedWhere(req, params);

        if (date) {
            if (!isDate(date)) return res.status(400).json({ success: false, message: 'Invalid date.' });
            where.push('r.res_date=?');
            params.push(date);
        }
        if (status) {
            if (!VALID_STATUS.includes(status)) return res.status(400).json({ success: false, message: 'Invalid status.' });
            where.push('r.status=?');
            params.push(status);
        }
        if (barber_id && req.user.role !== 'barber') {
            where.push('r.barber_id=?');
            params.push(barber_id);
        }
        const requestedBranch = toIntOrNull(branch_id);
        if (requestedBranch && req.user.role === 'admin') {
            where.push('r.branch_id=?');
            params.push(requestedBranch);
        }

        const [rows] = await db.query(
            `SELECT r.id, r.customer_name, r.customer_phone, r.res_date, r.res_time,
                     r.duration_min, r.notes, r.status, r.sale_id,
                    s.id AS primary_service_id, s.name AS primary_service_name,
                    s.price AS primary_service_price,
                    u.full_name AS barber_name, br.name AS branch_name,
                    GROUP_CONCAT(CONCAT(svc.id, '::', REPLACE(svc.name, '::', ' '), '::', rs.price, '::', rs.duration_minutes) ORDER BY rs.id SEPARATOR '||') AS services_blob
             FROM reservations r
             JOIN services s ON r.service_id=s.id
             JOIN users u ON r.barber_id=u.id
             JOIN branches br ON r.branch_id=br.id
             LEFT JOIN reservation_services rs ON rs.reservation_id=r.id
             LEFT JOIN services svc ON svc.id=rs.service_id
             WHERE ${where.join(' AND ')}
             GROUP BY r.id, r.customer_name, r.customer_phone, r.res_date, r.res_time,
                      r.duration_min, r.notes, r.status, r.sale_id, s.id, s.name, s.price,
                      u.full_name, br.name
             ORDER BY r.res_date DESC, r.res_time ASC`,
            params
        );

        return res.json({ success: true, data: shapeReservationRows(rows) });
    } catch (err) {
        logger.error('[RESERVATIONS-LIST]', err.message);
        return res.status(500).json({ success: false, message: 'Server error.' });
    }
};

const createReservation = async (req, res) => {
    try {
        const scopedBranchId = req.user.role === 'admin'
            ? (req.body.branch_id || req.query.branch_id)
            : req.user.branch_id;
        const result = await insertReservation({
            ...req.body,
            branch_id: scopedBranchId,
            created_by: req.user.id
        });
        if (result.error) {
            return res.status(result.error.code).json({ success: false, message: result.error.message });
        }

        const payload = {
            reservation_id: result.reservation_id,
            ticket_number: result.ticket_number,
            reservation: result.reservation
        };

        return res.status(201).json({
            success: true,
            data: payload,
            ...payload,
            message: `Reservation created. Ticket ${result.ticket_number}.`
        });
    } catch (err) {
        logger.error('[RESERVATION-CREATE]', err.message);
        return res.status(500).json({ success: false, message: 'Server error.' });
    }
};

const createPublicReservation = async (req, res) => {
    try {
        const result = await insertReservation(req.body);
        if (result.error) {
            return res.status(result.error.code).json({ success: false, message: result.error.message });
        }

        const payload = {
            reservation_id: result.reservation_id,
            ticket_number: result.ticket_number,
            reservation: result.reservation
        };

        return res.status(201).json({
            success: true,
            data: payload,
            ...payload,
            message: `Reservation received. Your ticket number is ${result.ticket_number}.`
        });
    } catch (err) {
        logger.error('[PUBLIC-RESERVATION-CREATE]', err.message);
        return res.status(500).json({ success: false, message: 'Server error.' });
    }
};

const updateReservationStatus = async (req, res) => {
    try {
        const { status } = req.body;
        if (!VALID_STATUS.includes(status)) {
            return res.status(400).json({ success: false, message: 'Invalid status.' });
        }

        const params = [req.params.id];
        const where = ['r.id=?', ...scopedWhere(req, params)];
        const [[existing]] = await db.query(`SELECT r.id FROM reservations r WHERE ${where.join(' AND ')} LIMIT 1`, params);
        if (!existing) return res.status(404).json({ success: false, message: 'Reservation not found.' });

        await db.query('UPDATE reservations SET status=?, updated_at=NOW() WHERE id=?', [status, req.params.id]);
        return res.json({ success: true, data: { id: Number(req.params.id), status }, message: 'Reservation status updated.' });
    } catch (err) {
        logger.error('[RESERVATION-STATUS]', err.message);
        return res.status(500).json({ success: false, message: 'Server error.' });
    }
};

const getAvailableSlots = async (req, res) => {
    try {
        const { barber_id, date } = req.query;
        if (!barber_id || !isDate(date)) {
            return res.status(400).json({ success: false, message: 'barber_id and valid date are required.' });
        }

        const [[barber]] = await db.query('SELECT branch_id FROM users WHERE id=? LIMIT 1', [barber_id]);
        if (!barber) return res.status(404).json({ success: false, message: 'Barber not found.' });
        if (req.user.role !== 'admin' && Number(barber.branch_id) !== Number(req.user.branch_id)) {
            return res.status(403).json({ success: false, message: 'This barber is outside your branch.' });
        }
        if (req.branchFilter && Number(barber.branch_id) !== Number(req.branchFilter)) {
            return res.status(403).json({ success: false, message: 'This barber is outside the selected branch.' });
        }

        const [taken] = await db.query(
            `SELECT TIME_FORMAT(res_time, '%H:%i') AS t
             FROM reservations
             WHERE barber_id=? AND res_date=? AND status NOT IN ('done','cancelled')`,
            [barber_id, date]
        );
        const takenSet = new Set(taken.map(r => r.t));
        const slots = [];

        for (let h = 9; h <= 19; h += 1) {
            for (const m of ['00', '30']) {
                const slot = `${String(h).padStart(2, '0')}:${m}`;
                if (!takenSet.has(slot)) slots.push(slot);
            }
        }

        return res.json({ success: true, data: slots });
    } catch (err) {
        logger.error('[RESERVATION-SLOTS]', err.message);
        return res.status(500).json({ success: false, message: 'Server error.' });
    }
};

const cancelReservation = async (req, res) => {
    try {
        const params = [req.params.id];
        const where = ['r.id=?', ...scopedWhere(req, params)];
        const [[existing]] = await db.query(`SELECT r.id FROM reservations r WHERE ${where.join(' AND ')} LIMIT 1`, params);
        if (!existing) return res.status(404).json({ success: false, message: 'Reservation not found.' });

        await db.query(
            "UPDATE reservations SET status='cancelled', updated_at=NOW() WHERE id=? AND status NOT IN ('done','cancelled')",
            [req.params.id]
        );
        return res.json({ success: true, data: { id: Number(req.params.id), status: 'cancelled' }, message: 'Reservation cancelled.' });
    } catch (err) {
        logger.error('[RESERVATION-CANCEL]', err.message);
        return res.status(500).json({ success: false, message: 'Server error.' });
    }
};

module.exports = {
    getReservations,
    createReservation,
    createPublicReservation,
    updateReservationStatus,
    getAvailableSlots,
    cancelReservation
};
