// ============================================================
// backend/routes/adminRoutes.js
// Mounted at: /api/admin
// Uses the completed owner dashboard controller under the admin role.
// ============================================================

const express = require('express');
const router  = express.Router();
const { adminOnly } = require('../middleware/authMiddleware');

const {
    getBranches,
    getDashboardStats,
    getSalesChart,
    getBarberPerformance,
    getSales,
    addSale,
    deleteSale,
    getBarbers,
    getPendingBarbers,
    approveBarber,
    rejectBarber,
    addBarber,
    updateBarber,
    getStaff,
    addStaff,
    updateStaff,
    getInventory,
    addInventoryItem,
    updateInventoryItem,
    restockItem,
    getExpenses,
    addExpense,
    deleteExpense,
    getServices,
    addService,
    updateService,
    deleteService,
    getMonthlyReport,
    getNotifications,
    markNotificationRead
} = require('../controllers/ownerController');

router.use(adminOnly);

// Dashboard
router.get('/stats',              getDashboardStats);
router.get('/branches',           getBranches);
router.get('/sales-chart',        getSalesChart);
router.get('/barber-performance', getBarberPerformance);
router.get('/report',             getMonthlyReport);
router.get('/reports',            getMonthlyReport);

// Sales
router.get   ('/sales',     getSales);
router.post  ('/sales',     addSale);
router.delete('/sales/:id', deleteSale);

// Barbers
router.get('/barbers/pending',      getPendingBarbers);
router.put('/barbers/:id/approve',  approveBarber);
router.put('/barbers/:id/reject',   rejectBarber);
router.get ('/barbers',             getBarbers);
router.post('/barbers',             addBarber);
router.put ('/barbers/:id',         updateBarber);

// Staff
router.get ('/staff',              getStaff);
router.post('/staff',              addStaff);
router.put ('/staff/:id',          updateStaff);

// Inventory
router.get ('/inventory',              getInventory);
router.post('/inventory',              addInventoryItem);
router.put ('/inventory/:id',          updateInventoryItem);
router.post('/inventory/:id/restock',  restockItem);

// Expenses
router.get   ('/expenses',     getExpenses);
router.post  ('/expenses',     addExpense);
router.delete('/expenses/:id', deleteExpense);

// Services
router.get ('/services',      getServices);
router.post('/services',      addService);
router.put ('/services/:id',  updateService);
router.delete('/services/:id', deleteService);

// Notifications
router.get('/notifications',          getNotifications);
router.put('/notifications/:id/read', markNotificationRead);

module.exports = router;
