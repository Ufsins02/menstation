const db = require('../config/db');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

const safeUser = (user, role) => ({
    id: user.id,
    full_name: user.full_name,
    email: user.email,
    role,
    owner_id: user.owner_id || user.id,
    branch_id: user.branch_id || null
});

const getJwtSecret = () => {
    if (!process.env.JWT_SECRET) {
        throw new Error('JWT_SECRET is required.');
    }
    return process.env.JWT_SECRET;
};

const login = async (req, res) => {
    try {
        const email = String(req.body.email || '').trim().toLowerCase();
        const { password } = req.body;

        if (!email || !password) {
            return res.status(400).json({
                success: false,
                message: 'Email and password are required'
            });
        }

        const [users] = await db.query(`
            SELECT users.*, roles.name AS role
            FROM users
            JOIN roles ON users.role_id = roles.id
            WHERE users.email = ?
            LIMIT 1
        `, [email]);

        if (!users.length) {
            return res.status(401).json({
                success: false,
                message: 'Invalid email or password'
            });
        }

        const user = users[0];

        if (!user.is_active || user.status !== 'approved') {
            return res.status(403).json({
                success: false,
                message: 'Account is not active or has not been approved.'
            });
        }

        const passwordMatch = await bcrypt.compare(password, user.password);
        if (!passwordMatch) {
            return res.status(401).json({
                success: false,
                message: 'Invalid email or password'
            });
        }

        const appRole = user.role === 'owner' ? 'admin' : user.role;
        const sessionUser = safeUser(user, appRole);
        const token = jwt.sign(
            {
                id: user.id,
                role: appRole,
                owner_id: sessionUser.owner_id,
                branch_id: sessionUser.branch_id
            },
            getJwtSecret(),
            { expiresIn: process.env.JWT_EXPIRES_IN || '7d' }
        );

        return res.json({
            success: true,
            message: 'Login successful',
            data: {
                token,
                user: sessionUser
            },
            token,
            user: sessionUser
        });
    } catch (error) {
        return res.status(500).json({
            success: false,
            message: 'Server error'
        });
    }
};

const changePassword = async (req, res) => {
    try {
        const { current_password, new_password } = req.body;

        if (!current_password || !new_password) {
            return res.status(400).json({
                success: false,
                message: 'Current password and new password are required'
            });
        }

        if (String(new_password).length < 8) {
            return res.status(400).json({
                success: false,
                message: 'New password must be at least 8 characters'
            });
        }

        const [[user]] = await db.query('SELECT id, password FROM users WHERE id = ? LIMIT 1', [req.user.id]);
        if (!user) {
            return res.status(404).json({ success: false, message: 'User not found' });
        }

        const passwordMatch = await bcrypt.compare(current_password, user.password);
        if (!passwordMatch) {
            return res.status(401).json({ success: false, message: 'Current password is incorrect' });
        }

        const hashed = await bcrypt.hash(new_password, 10);
        await db.query('UPDATE users SET password = ? WHERE id = ?', [hashed, req.user.id]);

        return res.json({ success: true, message: 'Password updated successfully' });
    } catch (error) {
        return res.status(500).json({ success: false, message: 'Server error' });
    }
};

module.exports = { login, changePassword };
