require('dotenv').config({ quiet: true });
const bcrypt = require('bcryptjs');
const db = require('./config/db');
const logger = require('./utils/logger');

const tablesToClear = [
    'inventory_adjustments',
    'inventory_usage',
    'inventory_restocks',
    'payroll',
    'notifications',
    'reservation_services',
    'reservations',
    'sales',
    'service_variants',
    'barber_works',
    'inventory',
    'expenses',
    'services',
    'barbers',
    'shop_profiles',
    'shop_settings',
    'users'
];

const required = (name) => {
    const value = process.env[name];
    if (!value || !String(value).trim()) {
        throw new Error(`${name} is required for production reset.`);
    }
    return String(value).trim();
};

const tableExists = async (name) => {
    const [[row]] = await db.query(
        `SELECT COUNT(*) AS total
         FROM information_schema.TABLES
         WHERE TABLE_SCHEMA = DATABASE()
           AND TABLE_NAME = ?`,
        [name]
    );
    return row.total > 0;
};

const ensureRoles = () =>
    db.query("INSERT IGNORE INTO roles (name) VALUES ('admin'), ('barber'), ('staff')");

const ensureBranch = async () => {
    const [branches] = await db.query('SELECT id FROM branches ORDER BY id LIMIT 1');
    if (branches.length) return branches[0].id;

    const [result] = await db.query(
        `INSERT INTO branches (name, location, phone, hours_weekday, hours_weekend)
         VALUES (?, ?, ?, ?, ?)`,
        [
            process.env.DEFAULT_BRANCH_NAME || 'Main Branch',
            process.env.DEFAULT_BRANCH_LOCATION || null,
            process.env.DEFAULT_BRANCH_PHONE || null,
            process.env.DEFAULT_BRANCH_HOURS_WEEKDAY || null,
            process.env.DEFAULT_BRANCH_HOURS_WEEKEND || null
        ]
    );
    return result.insertId;
};

const createAdmin = async (branchId) => {
    const email = required('ADMIN_EMAIL').toLowerCase();
    const password = required('ADMIN_PASSWORD');
    const name = process.env.ADMIN_NAME || 'System Admin';

    if (password.length < 12) {
        throw new Error('ADMIN_PASSWORD must be at least 12 characters.');
    }

    const [[role]] = await db.query("SELECT id FROM roles WHERE name='admin' LIMIT 1");
    const hash = await bcrypt.hash(password, 10);
    const [result] = await db.query(
        `INSERT INTO users
         (full_name, email, password, role_id, is_active, status, owner_id, branch_id)
         VALUES (?, ?, ?, ?, 1, 'approved', NULL, ?)`,
        [name, email, hash, role.id, branchId]
    );
    await db.query('UPDATE users SET owner_id=? WHERE id=?', [result.insertId, result.insertId]);
};

const resetProduction = async () => {
    try {
        await db.query('SET FOREIGN_KEY_CHECKS=0');
        for (const table of tablesToClear) {
            if (await tableExists(table)) {
                await db.query(`TRUNCATE TABLE ${table}`);
            }
        }
        await db.query('SET FOREIGN_KEY_CHECKS=1');

        await ensureRoles();
        const branchId = await ensureBranch();
        await createAdmin(branchId);

        logger.info('Production reset complete. Roles and one admin account are ready; services, sales, inventory, and reservations are empty.');
        process.exit(0);
    } catch (err) {
        await db.query('SET FOREIGN_KEY_CHECKS=1').catch(() => {});
        logger.error(`[RESET] ${err.message}`);
        process.exit(1);
    }
};

resetProduction();
