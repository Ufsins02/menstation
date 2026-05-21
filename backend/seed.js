require('dotenv').config({ quiet: true });
const bcrypt = require('bcryptjs');
const db = require('./config/db');
const logger = require('./utils/logger');

const required = (name) => {
    const value = process.env[name];
    if (!value || !String(value).trim()) {
        throw new Error(`${name} is required.`);
    }
    return String(value).trim();
};

const ensureDefaultBranch = async () => {
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

const seed = async () => {
    try {
        const adminEmail = required('ADMIN_EMAIL').toLowerCase();
        const adminPassword = required('ADMIN_PASSWORD');
        const adminName = process.env.ADMIN_NAME || 'System Admin';

        if (adminPassword.length < 12) {
            throw new Error('ADMIN_PASSWORD must be at least 12 characters.');
        }

        await db.query("INSERT IGNORE INTO roles (name) VALUES ('admin'), ('barber'), ('staff')");
        const branchId = await ensureDefaultBranch();

        const [existing] = await db.query('SELECT id FROM users WHERE email = ? LIMIT 1', [adminEmail]);
        if (existing.length) {
            logger.info('Admin account already exists.');
            process.exit(0);
        }

        const [[adminRole]] = await db.query("SELECT id FROM roles WHERE name = 'admin' LIMIT 1");
        const hashed = await bcrypt.hash(adminPassword, 10);
        const [result] = await db.query(
            `INSERT INTO users
             (full_name, email, password, role_id, is_active, status, owner_id, branch_id)
             VALUES (?, ?, ?, ?, 1, 'approved', NULL, ?)`,
            [adminName, adminEmail, hashed, adminRole.id, branchId]
        );

        await db.query('UPDATE users SET owner_id = ? WHERE id = ?', [result.insertId, result.insertId]);
        logger.info('Admin account created.');
        process.exit(0);
    } catch (err) {
        logger.error(`[SEED] ${err.message}`);
        process.exit(1);
    }
};

seed();
