-- ============================================================
-- MenStation Barbershop Management System
-- Database Schema
-- ============================================================

CREATE DATABASE IF NOT EXISTS menstation;
USE menstation;

-- ============================================================
-- TABLE: roles
-- Defines what role a user has: owner or barber
-- ============================================================
CREATE TABLE roles (
    id INT AUTO_INCREMENT PRIMARY KEY,
    name VARCHAR(50) NOT NULL UNIQUE,    -- 'owner' or 'barber'
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- ============================================================
-- TABLE: branches
-- Physical barbershop locations
-- ============================================================
CREATE TABLE branches (
    id INT AUTO_INCREMENT PRIMARY KEY,
    name VARCHAR(100) NOT NULL,
    location VARCHAR(255) DEFAULT NULL,
    phone VARCHAR(30) DEFAULT NULL,
    hours_weekday VARCHAR(120) DEFAULT NULL,
    hours_weekend VARCHAR(120) DEFAULT NULL,
    is_active TINYINT(1) DEFAULT 1,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
);

-- ============================================================
-- TABLE: users
-- All system users (owners + barbers)
-- ============================================================
CREATE TABLE users (
    id INT AUTO_INCREMENT PRIMARY KEY,
    full_name VARCHAR(100) NOT NULL,
    email VARCHAR(100) NOT NULL UNIQUE,
    password VARCHAR(255) NOT NULL,         -- bcrypt hashed
    role_id INT NOT NULL,                   -- FK → roles.id
    profile_photo MEDIUMTEXT DEFAULT NULL,
    phone VARCHAR(20) DEFAULT NULL,
    is_active TINYINT(1) DEFAULT 1,         -- 1 = active, 0 = deactivated
    status ENUM('pending','approved','rejected') DEFAULT 'approved',
    owner_id INT NULL DEFAULT NULL,
    branch_id INT NULL DEFAULT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    FOREIGN KEY (role_id) REFERENCES roles(id)
);

-- ============================================================
-- TABLE: barbers
-- Extended barber profile info (linked to users)
-- ============================================================
CREATE TABLE barbers (
    id INT AUTO_INCREMENT PRIMARY KEY,
    user_id INT NOT NULL UNIQUE,            -- FK → users.id (1:1)
    nickname VARCHAR(50) DEFAULT NULL,
    hire_date DATE DEFAULT NULL,
    commission_rate DECIMAL(5,2) DEFAULT 50.00, -- % commission per sale
    specialization VARCHAR(100) DEFAULT NULL,
    bio TEXT DEFAULT NULL,
    is_featured TINYINT(1) DEFAULT 0,       -- Show on public page
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

-- ============================================================
-- TABLE: services
-- Services offered by the barbershop
-- ============================================================
CREATE TABLE services (
    id INT AUTO_INCREMENT PRIMARY KEY,
    owner_id INT NULL DEFAULT NULL,
    branch_id INT NULL DEFAULT NULL,
    name VARCHAR(100) NOT NULL,
    description TEXT DEFAULT NULL,
    price DECIMAL(10,2) NOT NULL,
    duration_minutes INT DEFAULT 30,
    category VARCHAR(50) DEFAULT NULL,
    image_url TEXT DEFAULT NULL,
    is_active TINYINT(1) DEFAULT 1,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- ============================================================
-- TABLE: barber_works
-- Public portfolio images added by barber users
-- ============================================================
CREATE TABLE barber_works (
    id INT AUTO_INCREMENT PRIMARY KEY,
    barber_id INT NOT NULL,
    image_url MEDIUMTEXT NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (barber_id) REFERENCES users(id) ON DELETE CASCADE
);

-- ============================================================
-- TABLE: service_variants
-- Optional visual variants attached to a service
-- ============================================================
CREATE TABLE service_variants (
    id INT AUTO_INCREMENT PRIMARY KEY,
    service_id INT NOT NULL,
    name VARCHAR(100) NOT NULL,
    image_url TEXT DEFAULT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (service_id) REFERENCES services(id) ON DELETE CASCADE
);

-- ============================================================
-- TABLE: reservations
-- Customer reservations, with service_id kept as first service
-- ============================================================
CREATE TABLE reservations (
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
    INDEX idx_status (status),
    FOREIGN KEY (service_id) REFERENCES services(id),
    FOREIGN KEY (barber_id) REFERENCES users(id),
    FOREIGN KEY (branch_id) REFERENCES branches(id),
    FOREIGN KEY (owner_id) REFERENCES users(id)
);

-- ============================================================
-- TABLE: reservation_services
-- Services attached to a reservation, supports multi-service bookings
-- ============================================================
CREATE TABLE reservation_services (
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

-- ============================================================
-- TABLE: sales
-- Each completed service/transaction
-- ============================================================
CREATE TABLE sales (
    id INT AUTO_INCREMENT PRIMARY KEY,
    owner_id INT NULL DEFAULT NULL,
    branch_id INT NULL DEFAULT NULL,
    barber_id INT NOT NULL,                 -- FK → users.id (the barber)
    service_id INT NOT NULL,                -- FK → services.id
    customer_name VARCHAR(100) DEFAULT 'Walk-in',
    amount DECIMAL(10,2) NOT NULL,          -- Total paid
    commission_amount DECIMAL(10,2) NOT NULL, -- Barber's cut
    payment_method ENUM('cash','gcash','card','other') DEFAULT 'cash',
    notes TEXT DEFAULT NULL,
    sale_date DATE NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (barber_id) REFERENCES users(id),
    FOREIGN KEY (service_id) REFERENCES services(id)
);

-- ============================================================
-- TABLE: inventory
-- Products used in the shop (pomade, shampoo, blades, etc.)
-- ============================================================
CREATE TABLE inventory (
    id INT AUTO_INCREMENT PRIMARY KEY,
    owner_id INT NULL DEFAULT NULL,
    branch_id INT NULL DEFAULT NULL,
    name VARCHAR(100) NOT NULL,
    category VARCHAR(50) DEFAULT 'supplies', -- supplies, tools, retail
    unit VARCHAR(30) DEFAULT 'pcs',          -- pcs, ml, g, bottle
    quantity_in_stock DECIMAL(10,2) DEFAULT 0,
    reorder_level DECIMAL(10,2) DEFAULT 5,   -- Alert when below this
    cost_per_unit DECIMAL(10,2) DEFAULT 0,
    selling_price DECIMAL(10,2) DEFAULT 0,   -- If sold to customers
    supplier VARCHAR(100) DEFAULT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
);

-- ============================================================
-- TABLE: inventory_usage
-- Tracks products used per service
-- ============================================================
CREATE TABLE inventory_usage (
    id INT AUTO_INCREMENT PRIMARY KEY,
    sale_id INT NOT NULL,                   -- FK → sales.id
    inventory_id INT NOT NULL,              -- FK → inventory.id
    quantity_used DECIMAL(10,2) NOT NULL,
    used_date DATE NOT NULL,
    FOREIGN KEY (sale_id) REFERENCES sales(id),
    FOREIGN KEY (inventory_id) REFERENCES inventory(id)
);

-- ============================================================
-- TABLE: inventory_restocks
-- Records when inventory is replenished
-- ============================================================
CREATE TABLE inventory_restocks (
    id INT AUTO_INCREMENT PRIMARY KEY,
    inventory_id INT NOT NULL,
    quantity_added DECIMAL(10,2) NOT NULL,
    cost_total DECIMAL(10,2) DEFAULT 0,
    supplier VARCHAR(100) DEFAULT NULL,
    restock_date DATE NOT NULL,
    notes TEXT DEFAULT NULL,
    added_by INT NOT NULL,                  -- FK → users.id
    FOREIGN KEY (inventory_id) REFERENCES inventory(id),
    FOREIGN KEY (added_by) REFERENCES users(id)
);

-- ============================================================
-- TABLE: inventory_adjustments
-- Branch stock changes recorded by staff or admin users
-- ============================================================
CREATE TABLE inventory_adjustments (
    id INT AUTO_INCREMENT PRIMARY KEY,
    inventory_id INT NOT NULL,
    branch_id INT NOT NULL,
    user_id INT NOT NULL,
    quantity_delta DECIMAL(10,2) NOT NULL,
    reason VARCHAR(255) DEFAULT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_inventory (inventory_id),
    INDEX idx_branch (branch_id),
    INDEX idx_user (user_id),
    FOREIGN KEY (inventory_id) REFERENCES inventory(id),
    FOREIGN KEY (branch_id) REFERENCES branches(id),
    FOREIGN KEY (user_id) REFERENCES users(id)
);

-- ============================================================
-- TABLE: expenses
-- Shop operating expenses (rent, utilities, supplies, etc.)
-- ============================================================
CREATE TABLE expenses (
    id INT AUTO_INCREMENT PRIMARY KEY,
    owner_id INT NULL DEFAULT NULL,
    branch_id INT NULL DEFAULT NULL,
    title VARCHAR(100) NOT NULL,
    category ENUM('rent','utilities','supplies','equipment','salary','marketing','other') DEFAULT 'other',
    amount DECIMAL(10,2) NOT NULL,
    expense_date DATE NOT NULL,
    paid_to VARCHAR(100) DEFAULT NULL,
    receipt_photo VARCHAR(255) DEFAULT NULL,
    notes TEXT DEFAULT NULL,
    recorded_by INT NOT NULL,               -- FK → users.id
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (recorded_by) REFERENCES users(id)
);

-- ============================================================
-- TABLE: payroll
-- Monthly barber payroll records
-- ============================================================
CREATE TABLE payroll (
    id INT AUTO_INCREMENT PRIMARY KEY,
    barber_id INT NOT NULL,                 -- FK → users.id
    period_start DATE NOT NULL,
    period_end DATE NOT NULL,
    total_sales DECIMAL(10,2) DEFAULT 0,
    commission_earned DECIMAL(10,2) DEFAULT 0,
    bonus DECIMAL(10,2) DEFAULT 0,  
    deductions DECIMAL(10,2) DEFAULT 0,
    net_pay DECIMAL(10,2) DEFAULT 0,
    is_paid TINYINT(1) DEFAULT 0,
    paid_date DATE DEFAULT NULL,
    notes TEXT DEFAULT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (barber_id) REFERENCES users(id)
);

-- ============================================================
-- TABLE: notifications
-- System alerts (low inventory, performance, etc.)
-- ============================================================
CREATE TABLE notifications (
    id INT AUTO_INCREMENT PRIMARY KEY,
    user_id INT NOT NULL,                   -- FK → users.id (recipient)
    title VARCHAR(100) NOT NULL,
    message TEXT NOT NULL,
    type ENUM('info','warning','alert','success') DEFAULT 'info',
    is_read TINYINT(1) DEFAULT 0,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

-- ============================================================
-- TABLE: shop_settings
-- Barbershop public info (name, hours, address, etc.)
-- ============================================================
CREATE TABLE shop_settings (
    id INT AUTO_INCREMENT PRIMARY KEY,
    setting_key VARCHAR(100) NOT NULL UNIQUE,
    setting_value TEXT,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
);

-- ============================================================
-- SEED DATA: Insert default roles
-- ============================================================
INSERT INTO roles (name) VALUES ('admin'), ('barber'), ('staff');

-- Production data is intentionally not seeded.
-- Create the first admin and default branch with: npm run seed
-- Add services, barbers, staff, inventory, shop settings, and reservations from the app.
