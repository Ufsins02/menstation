// ============================================================
// backend/routes/staffRoutes.js
// Mounted at: /api/staff
// Staff (cashier) role only.
// Price enforcement is in the controller — no overrides allowed.
// ============================================================

const express = require('express');
const router  = express.Router();
const { staffOnly } = require('../middleware/authMiddleware');

const {
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
} = require('../controllers/staffController');

// All staff routes: staff cashier role only
router.use(staffOnly);

// Dashboard stats for the branch
router.get('/stats',                           getStaffStats);

// Read-only service list (no price edit allowed)
router.get('/services',                        getServices);

// Barbers in this branch (for assigning service)
router.get('/barbers',                         getBranchBarbers);

// Sales — create (price locked to DB) + list today's
router.post('/sales',                          createSale);
router.get ('/sales',                          getSales);

// Reservations for this branch
router.get('/reservations',                    getReservations);
router.get('/calendar',                        getCalendar);

// Inventory usage tracking. Staff can view and adjust stock only.
router.get('/inventory',                       getInventory);
router.put('/inventory/update',                updateInventoryQuantity);

// One-click: complete reservation → auto-create sale
router.put('/reservations/:id/complete',       completeReservation);

// Cancel an open reservation in this branch
router.delete('/reservations/:id',             cancelReservation);

module.exports = router;
