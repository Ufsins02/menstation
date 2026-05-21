const jwt = require('jsonwebtoken');
const { normalizeBranchId } = require('../utils/branchFilter');
require('dotenv').config({ quiet: true });

const getJwtSecret = () => {
    if (!process.env.JWT_SECRET) {
        throw new Error('JWT_SECRET is required.');
    }
    return process.env.JWT_SECRET;
};

const parseBranchFilter = (value) => normalizeBranchId(value);

const protect = (req, res, next) => {
    const authHeader = req.headers.authorization;
    const token = authHeader && authHeader.split(' ')[1];

    if (!token) {
        return res.status(401).json({ success: false, message: 'No token provided. Please log in.' });
    }

    try {
        req.user = jwt.verify(token, getJwtSecret());
        return next();
    } catch (err) {
        return res.status(403).json({ success: false, message: 'Invalid or expired token. Please log in again.' });
    }
};

const requireRole = (roles, message) => (req, res, next) => {
    protect(req, res, () => {
        if (!roles.includes(req.user.role)) {
            return res.status(403).json({ success: false, message });
        }
        return next();
    });
};

const adminOnly = requireRole(['admin'], 'Admin access required.');
const barberOnly = requireRole(['barber'], 'Barber account required.');
const staffOnly = requireRole(['staff'], 'Staff account required.');
const adminOrStaff = requireRole(['admin', 'staff'], 'Admin or staff access required.');

const anyRole = (req, res, next) => protect(req, res, next);

const branchScope = (req, res, next) => {
    protect(req, res, () => {
        req.branchFilter = req.user.role === 'admin'
            ? parseBranchFilter(req.query.branch_id)
            : req.user.branch_id;
        return next();
    });
};

const ownerOnly = adminOnly;

module.exports = { protect, adminOnly, ownerOnly, barberOnly, staffOnly, adminOrStaff, anyRole, branchScope };
