const express = require('express');
const router = express.Router();

const { protect } = require('../middleware/authMiddleware');
const admin = require('../controllers/ownerController');
const staff = require('../controllers/staffController');
const barber = require('../controllers/barberController');

const forbidden = (res, message = 'Access denied.') =>
    res.status(403).json({ success: false, message, data: null });

const dispatch = (handlers) => (req, res, next) => {
    const handler = handlers[req.user.role];
    if (!handler) return forbidden(res);
    return handler(req, res, next);
};

router.use(protect);

router.get('/sales', dispatch({
    admin: admin.getSales,
    staff: staff.getSales,
    barber: barber.getMySales
}));
router.post('/sales', dispatch({
    admin: admin.addSale,
    staff: staff.createSale
}));
router.delete('/sales/:id', dispatch({
    admin: admin.deleteSale
}));

router.get('/inventory', dispatch({
    admin: admin.getInventory,
    staff: staff.getInventory
}));
router.post('/inventory', dispatch({
    admin: admin.addInventoryItem
}));
router.put('/inventory/update', dispatch({
    staff: staff.updateInventoryQuantity
}));
router.put('/inventory/:id', dispatch({
    admin: admin.updateInventoryItem
}));
router.post('/inventory/:id/restock', dispatch({
    admin: admin.restockItem
}));

module.exports = router;
