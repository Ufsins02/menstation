const express = require('express');
const router = express.Router();

const {
    getPublicBarbers,
    getPublicBranches,
    getPublicBranch,
    getPublicServices,
    getPublicInfo
} = require('../controllers/barberController');
const { createPublicReservation } = require('../controllers/reservationController');

router.get('/public/info', getPublicInfo);
router.get('/public/branches', getPublicBranches);
router.get('/public/services', getPublicServices);
router.get('/public/branch/:id', getPublicBranch);
router.get('/public/barbers', getPublicBarbers);
router.post('/public/reservations', createPublicReservation);

router.get('/services', getPublicServices);
router.get('/branches', getPublicBranches);

module.exports = router;
