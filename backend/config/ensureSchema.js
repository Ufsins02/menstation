const db = require('./db');
const logger = require('../utils/logger');

const columnExists = async (table, column) => {
    const [[row]] = await db.query(
        `SELECT COUNT(*) AS total
         FROM information_schema.COLUMNS
         WHERE TABLE_SCHEMA = DATABASE()
           AND TABLE_NAME = ?
           AND COLUMN_NAME = ?`,
        [table, column]
    );
    return row.total > 0;
};

const addColumnIfMissing = async (table, column, definition) => {
    if (await columnExists(table, column)) return;
    await db.query(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
    logger.info(`[SCHEMA] Added ${table}.${column}`);
};

const ensureRoles = async () => {
    await db.query("INSERT IGNORE INTO roles (name) VALUES ('admin'), ('barber'), ('staff')");

    const [[ownerRole]] = await db.query("SELECT id FROM roles WHERE name='owner' LIMIT 1");
    const [[adminRole]] = await db.query("SELECT id FROM roles WHERE name='admin' LIMIT 1");

    if (!ownerRole) return;

    if (adminRole) {
        await db.query('UPDATE users SET role_id=? WHERE role_id=?', [adminRole.id, ownerRole.id]);
        await db.query('DELETE FROM roles WHERE id=?', [ownerRole.id]);
    } else {
        await db.query("UPDATE roles SET name='admin' WHERE id=?", [ownerRole.id]);
    }
    logger.info('[SCHEMA] Migrated owner role to admin');
};

const ensureRequiredSchema = async () => {
    await db.query(`
        CREATE TABLE IF NOT EXISTS branches (
            id INT AUTO_INCREMENT PRIMARY KEY,
            name VARCHAR(100) NOT NULL,
            location VARCHAR(255) DEFAULT NULL,
            phone VARCHAR(30) DEFAULT NULL,
            hours_weekday VARCHAR(120) DEFAULT NULL,
            hours_weekend VARCHAR(120) DEFAULT NULL,
            is_active TINYINT(1) DEFAULT 1,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
        )
    `);

    await addColumnIfMissing('branches', 'hours_weekday', 'VARCHAR(120) NULL AFTER phone');
    await addColumnIfMissing('branches', 'hours_weekend', 'VARCHAR(120) NULL AFTER hours_weekday');

    await db.query(`
        CREATE TABLE IF NOT EXISTS reservations (
            id INT AUTO_INCREMENT PRIMARY KEY,
            customer_name VARCHAR(100) NOT NULL,
            customer_phone VARCHAR(30) DEFAULT NULL,
            service_id INT NOT NULL,
            barber_id INT NOT NULL,
            branch_id INT NOT NULL,
            owner_id INT NOT NULL,
            res_date DATE NOT NULL,
            res_time TIME NOT NULL,
            duration_min INT DEFAULT 30,
            notes TEXT DEFAULT NULL,
            status ENUM('pending','confirmed','in_progress','done','cancelled') DEFAULT 'pending',
            sale_id INT NULL DEFAULT NULL,
            created_by INT NOT NULL,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
            INDEX idx_owner (owner_id),
            INDEX idx_branch (branch_id),
            INDEX idx_barber (barber_id),
            INDEX idx_date (res_date),
            INDEX idx_status (status)
        )
    `);

    await db.query(`
        CREATE TABLE IF NOT EXISTS reservation_services (
            id INT AUTO_INCREMENT PRIMARY KEY,
            reservation_id INT NOT NULL,
            service_id INT NOT NULL,
            price DECIMAL(10,2) NOT NULL DEFAULT 0,
            duration_minutes INT NOT NULL DEFAULT 30,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
            INDEX idx_reservation (reservation_id),
            INDEX idx_service (service_id),
            CONSTRAINT fk_reservation_services_reservation
                FOREIGN KEY (reservation_id) REFERENCES reservations(id)
                ON DELETE CASCADE,
            CONSTRAINT fk_reservation_services_service
                FOREIGN KEY (service_id) REFERENCES services(id)
        )
    `);

    await db.query(`
        INSERT INTO reservation_services (reservation_id, service_id, price, duration_minutes)
        SELECT r.id, r.service_id, COALESCE(s.price, 0), COALESCE(s.duration_minutes, r.duration_min, 30)
        FROM reservations r
        JOIN services s ON s.id = r.service_id
        LEFT JOIN reservation_services rs ON rs.reservation_id = r.id
        WHERE rs.id IS NULL
    `).catch(() => {});

    await db.query(`
        CREATE TABLE IF NOT EXISTS inventory_adjustments (
            id INT AUTO_INCREMENT PRIMARY KEY,
            inventory_id INT NOT NULL,
            branch_id INT NOT NULL,
            user_id INT NOT NULL,
            quantity_delta DECIMAL(10,2) NOT NULL,
            reason VARCHAR(255) DEFAULT NULL,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            INDEX idx_inventory (inventory_id),
            INDEX idx_branch (branch_id),
            INDEX idx_user (user_id)
        )
    `);

    await addColumnIfMissing('users', 'owner_id', 'INT NULL AFTER is_active');
    await addColumnIfMissing(
        'users',
        'status',
        "ENUM('pending','approved','rejected') DEFAULT 'approved' AFTER is_active"
    );
    await addColumnIfMissing('users', 'branch_id', 'INT NULL AFTER owner_id');

    await addColumnIfMissing('services', 'owner_id', 'INT NULL AFTER id');
    await addColumnIfMissing('services', 'branch_id', 'INT NULL AFTER owner_id');
    await addColumnIfMissing('services', 'image_url', 'TEXT NULL AFTER category');
    await addColumnIfMissing('sales', 'owner_id', 'INT NULL AFTER id');
    await addColumnIfMissing('sales', 'branch_id', 'INT NULL AFTER owner_id');
    await addColumnIfMissing('inventory', 'owner_id', 'INT NULL AFTER id');
    await addColumnIfMissing('inventory', 'branch_id', 'INT NULL AFTER owner_id');
    await addColumnIfMissing('expenses', 'owner_id', 'INT NULL AFTER id');
    await addColumnIfMissing('expenses', 'branch_id', 'INT NULL AFTER owner_id');

    await ensureRoles();

    await db.query('ALTER TABLE users MODIFY COLUMN profile_photo MEDIUMTEXT NULL').catch(() => {});
    await db.query(`
        CREATE TABLE IF NOT EXISTS barber_works (
            id INT AUTO_INCREMENT PRIMARY KEY,
            barber_id INT NOT NULL,
            image_url MEDIUMTEXT NOT NULL,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            INDEX idx_barber (barber_id),
            CONSTRAINT fk_barber_works_user
                FOREIGN KEY (barber_id) REFERENCES users(id)
                ON DELETE CASCADE
        )
    `);

    await db.query(`
        CREATE TABLE IF NOT EXISTS service_variants (
            id INT AUTO_INCREMENT PRIMARY KEY,
            service_id INT NOT NULL,
            name VARCHAR(100) NOT NULL,
            image_url TEXT DEFAULT NULL,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            INDEX idx_service (service_id),
            CONSTRAINT fk_service_variants_service
                FOREIGN KEY (service_id) REFERENCES services(id)
                ON DELETE CASCADE
        )
    `);

    const [[branch]] = await db.query('SELECT id FROM branches ORDER BY id LIMIT 1');
    const [[admin]] = await db.query(`
        SELECT u.id
        FROM users u
        JOIN roles r ON u.role_id = r.id
        WHERE r.name='admin'
        ORDER BY u.id
        LIMIT 1
    `);

    if (branch) {
        await db.query('UPDATE users SET branch_id=? WHERE branch_id IS NULL', [branch.id]);
        for (const table of ['services', 'sales', 'inventory', 'expenses']) {
            await db.query(`UPDATE ${table} SET branch_id=? WHERE branch_id IS NULL`, [branch.id]);
        }
    }

    if (admin) {
        await db.query(`
            UPDATE users u
            JOIN roles r ON u.role_id = r.id
            SET u.owner_id = u.id
            WHERE r.name='admin' AND u.owner_id IS NULL
        `);
        await db.query('UPDATE users SET owner_id=? WHERE owner_id IS NULL', [admin.id]);
        for (const table of ['services', 'sales', 'inventory', 'expenses']) {
            await db.query(`UPDATE ${table} SET owner_id=? WHERE owner_id IS NULL`, [admin.id]);
        }
    }

    await db.query("UPDATE users SET status='approved' WHERE status IS NULL");

    logger.info('[SCHEMA] Required MenStation columns verified');
};

module.exports = { ensureRequiredSchema };
