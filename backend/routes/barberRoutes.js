// ============================================================
// backend/routes/barberRoutes.js
// v3: Barber views only — NO sale creation
//     Mounted at: /api/barber
// ============================================================

const express = require('express');
const router  = express.Router();
const { protect, barberOnly } = require('../middleware/authMiddleware');
const {
    getMyStats,
    getMyReservations,
    getMySales,
    getMyWeeklyChart,
    getServices,
    getMyProfile,
    updateMyProfile,
    addWorkImage,
    deleteWorkImage,
    getWorkImagesByBarber
} = require('../controllers/barberController');

// Public portfolio images are displayed on the landing page.
router.get('/work-images/:barber_id', getWorkImagesByBarber);
router.delete('/work-images/:id', protect, deleteWorkImage);

// All routes below: barber JWT required
router.use(barberOnly);

router.get('/stats',            getMyStats);
router.get('/reservations',     getMyReservations);   // Replaces /sales entry
router.get('/sales',            getMySales);           // Read-only history
router.get('/weekly-chart',     getMyWeeklyChart);
router.get('/services',         getServices);
router.get('/profile',          getMyProfile);
router.put('/profile',          updateMyProfile);
router.post('/work-images',     addWorkImage);

// NOTE: No POST /barber/sales — barbers cannot create sales directly.
//       Sales are created by staff via /api/staff/sales or
//       auto-created when a reservation is marked done.

module.exports = router;
