-- ============================================================
-- MenStation — Migration v3
-- Adds: branches, reservations, staff role, branch_id scoping
-- Removes: public registration (handled in app layer)
-- Run AFTER migration_v2.sql
-- ============================================================

USE menstation;

-- ============================================================
-- STEP 1: Update roles table
-- Replace 'owner' with 'admin', add 'staff'
-- ============================================================
INSERT IGNORE INTO roles (name) VALUES ('admin'), ('staff');

-- Rename 'owner' to 'admin' if it exists (safe update)
UPDATE roles SET name = 'admin' WHERE name = 'owner';

-- ============================================================
-- STEP 2: branches table
-- Each physical shop location
-- ============================================================
CREATE TABLE IF NOT EXISTS branches (
    id         INT AUTO_INCREMENT PRIMARY KEY,
    name       VARCHAR(100) NOT NULL,
    location   VARCHAR(255) DEFAULT NULL,
    phone      VARCHAR(30)  DEFAULT NULL,
    hours_weekday VARCHAR(120) DEFAULT NULL,
    hours_weekend VARCHAR(120) DEFAULT NULL,
    is_active  TINYINT(1)   DEFAULT 1,
    created_at TIMESTAMP    DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP    DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
);

-- Default branch for existing data
INSERT INTO branches (name, location)
SELECT 'Main Branch', 'Primary Location'
WHERE NOT EXISTS (SELECT 1 FROM branches LIMIT 1);

INSERT INTO branches (name, location, phone, hours_weekday, hours_weekend)
SELECT 'Annex Branch', 'Annex Branch, Valenzuela City', '+63 917 555 0198',
       'Monday - Friday: 10:00 AM - 8:00 PM',
       'Saturday - Sunday: 9:00 AM - 9:00 PM'
WHERE NOT EXISTS (SELECT 1 FROM branches WHERE name='Annex Branch');

-- ============================================================
-- STEP 3: Add branch_id to all relevant tables
-- ============================================================
ALTER TABLE users
    ADD COLUMN IF NOT EXISTS owner_id INT NULL DEFAULT NULL AFTER is_active;

ALTER TABLE users
    ADD COLUMN IF NOT EXISTS status ENUM('pending','approved','rejected') DEFAULT 'approved' AFTER is_active;

ALTER TABLE users
    ADD COLUMN IF NOT EXISTS branch_id INT NULL DEFAULT NULL AFTER owner_id;

ALTER TABLE services
    ADD COLUMN IF NOT EXISTS owner_id INT NULL DEFAULT NULL AFTER id;

ALTER TABLE services
    ADD COLUMN IF NOT EXISTS branch_id INT NULL DEFAULT NULL AFTER owner_id;

ALTER TABLE services
    ADD COLUMN IF NOT EXISTS image_url TEXT NULL AFTER category;

ALTER TABLE users
    MODIFY COLUMN profile_photo MEDIUMTEXT NULL;

CREATE TABLE IF NOT EXISTS barber_works (
    id INT AUTO_INCREMENT PRIMARY KEY,
    barber_id INT NOT NULL,
    image_url MEDIUMTEXT NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_barber (barber_id),
    FOREIGN KEY (barber_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS service_variants (
    id INT AUTO_INCREMENT PRIMARY KEY,
    service_id INT NOT NULL,
    name VARCHAR(100) NOT NULL,
    image_url TEXT DEFAULT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_service (service_id),
    FOREIGN KEY (service_id) REFERENCES services(id) ON DELETE CASCADE
);

ALTER TABLE sales
    ADD COLUMN IF NOT EXISTS owner_id INT NULL DEFAULT NULL AFTER id;

ALTER TABLE sales
    ADD COLUMN IF NOT EXISTS branch_id INT NULL DEFAULT NULL AFTER owner_id;

ALTER TABLE inventory
    ADD COLUMN IF NOT EXISTS owner_id INT NULL DEFAULT NULL AFTER id;

ALTER TABLE inventory
    ADD COLUMN IF NOT EXISTS branch_id INT NULL DEFAULT NULL AFTER owner_id;

ALTER TABLE expenses
    ADD COLUMN IF NOT EXISTS owner_id INT NULL DEFAULT NULL AFTER id;

ALTER TABLE expenses
    ADD COLUMN IF NOT EXISTS branch_id INT NULL DEFAULT NULL AFTER owner_id;

-- ============================================================
-- STEP 4: reservations table
-- Core booking system
-- ============================================================
CREATE TABLE IF NOT EXISTS reservations (
    id            INT AUTO_INCREMENT PRIMARY KEY,
    customer_name VARCHAR(100)  NOT NULL,
    customer_phone VARCHAR(30)  DEFAULT NULL,
    service_id    INT           NOT NULL,
    barber_id     INT           NOT NULL,
    branch_id     INT           NOT NULL,
    owner_id      INT           NOT NULL,
    res_date      DATE          NOT NULL,           -- reservation date
    res_time      TIME          NOT NULL,           -- reservation time
    duration_min  INT           DEFAULT 30,         -- from service
    notes         TEXT          DEFAULT NULL,
    status        ENUM('pending','confirmed','in_progress','done','cancelled')
                                DEFAULT 'pending',
    sale_id       INT           NULL DEFAULT NULL,  -- set when converted to sale
    created_by    INT           NOT NULL,           -- staff or admin user id
    created_at    TIMESTAMP     DEFAULT CURRENT_TIMESTAMP,
    updated_at    TIMESTAMP     DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    FOREIGN KEY (service_id) REFERENCES services(id),
    FOREIGN KEY (barber_id)  REFERENCES users(id),
    FOREIGN KEY (branch_id)  REFERENCES branches(id),
    INDEX idx_owner    (owner_id),
    INDEX idx_branch   (branch_id),
    INDEX idx_barber   (barber_id),
    INDEX idx_date     (res_date),
    INDEX idx_status   (status)
);

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
    FOREIGN KEY (reservation_id) REFERENCES reservations(id) ON DELETE CASCADE,
    FOREIGN KEY (service_id) REFERENCES services(id)
);

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
);

INSERT INTO reservation_services (reservation_id, service_id, price, duration_minutes)
SELECT r.id, r.service_id, COALESCE(s.price, 0), COALESCE(s.duration_minutes, r.duration_min, 30)
FROM reservations r
JOIN services s ON s.id = r.service_id
LEFT JOIN reservation_services rs ON rs.reservation_id = r.id
WHERE rs.id IS NULL;

-- ============================================================
-- STEP 5: Backfill branch_id = 1 for existing data
-- ============================================================
UPDATE users u
JOIN roles r ON u.role_id = r.id
SET u.owner_id = u.id
WHERE r.name = 'admin' AND u.owner_id IS NULL;

UPDATE users      SET owner_id = (SELECT id FROM (SELECT id FROM users ORDER BY id LIMIT 1) x) WHERE owner_id IS NULL;
UPDATE services   SET owner_id = (SELECT id FROM (SELECT id FROM users ORDER BY id LIMIT 1) x) WHERE owner_id IS NULL;
UPDATE sales      SET owner_id = (SELECT id FROM (SELECT id FROM users ORDER BY id LIMIT 1) x) WHERE owner_id IS NULL;
UPDATE inventory  SET owner_id = (SELECT id FROM (SELECT id FROM users ORDER BY id LIMIT 1) x) WHERE owner_id IS NULL;
UPDATE expenses   SET owner_id = (SELECT id FROM (SELECT id FROM users ORDER BY id LIMIT 1) x) WHERE owner_id IS NULL;

UPDATE users      SET branch_id = 1 WHERE branch_id IS NULL;
UPDATE services   SET branch_id = 1 WHERE branch_id IS NULL;
UPDATE sales      SET branch_id = 1 WHERE branch_id IS NULL;
UPDATE inventory  SET branch_id = 1 WHERE branch_id IS NULL;
UPDATE expenses   SET branch_id = 1 WHERE branch_id IS NULL;

-- ============================================================
-- STEP 6: branch_id indexes for performance
-- ============================================================
ALTER TABLE users      ADD INDEX IF NOT EXISTS idx_branch (branch_id);
ALTER TABLE users      ADD INDEX IF NOT EXISTS idx_owner (owner_id);
ALTER TABLE services   ADD INDEX IF NOT EXISTS idx_branch (branch_id);
ALTER TABLE services   ADD INDEX IF NOT EXISTS idx_owner (owner_id);
ALTER TABLE sales      ADD INDEX IF NOT EXISTS idx_branch (branch_id);
ALTER TABLE sales      ADD INDEX IF NOT EXISTS idx_owner (owner_id);
ALTER TABLE inventory  ADD INDEX IF NOT EXISTS idx_branch (branch_id);
ALTER TABLE inventory  ADD INDEX IF NOT EXISTS idx_owner (owner_id);

-- ============================================================
-- STEP 7: Admin creation
-- ============================================================
-- The app seed script creates the first admin from environment variables.
-- Do not hard-code passwords in SQL files.

SELECT 'Migration v3 complete.' AS result;
