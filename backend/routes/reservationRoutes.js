// ============================================================
// backend/routes/reservationRoutes.js
// Mounted at: /api/reservations
// Admin: all branches (optional filter)
// Barber: own reservations in own branch
// Staff: all reservations in own branch
// ============================================================

const express = require('express');
const router  = express.Router();
const { anyRole, branchScope } = require('../middleware/authMiddleware');

const {
    getReservations,
    createReservation,
    updateReservationStatus,
    getAvailableSlots,
    cancelReservation
} = require('../controllers/reservationController');

// All reservation routes require authentication + branch scope
router.use(anyRole);
router.use(branchScope);

// GET /api/reservations?date=YYYY-MM-DD&status=pending&barber_id=&branch_id=
router.get('/',              getReservations);

// GET /api/reservations/available?barber_id=&date=YYYY-MM-DD
router.get('/available',     getAvailableSlots);

// POST /api/reservations
router.post('/',             createReservation);

// PUT /api/reservations/:id/status  { status, payment_method }
router.put('/:id/status',   updateReservationStatus);

// DELETE /api/reservations/:id  (sets status=cancelled)
router.delete('/:id',       cancelReservation);

module.exports = router;