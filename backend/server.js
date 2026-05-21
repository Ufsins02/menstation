const express = require('express');
const cors = require('cors');
const path = require('path');
require('dotenv').config({ quiet: true });

const { ensureRequiredSchema } = require('./config/ensureSchema');
const logger = require('./utils/logger');

const app = express();
const PORT = process.env.PORT || 3000;

const validateEnvironment = () => {
    const required = ['DB_HOST', 'DB_USER', 'DB_NAME', 'JWT_SECRET'];
    const missing = required.filter(name => !process.env[name] || !String(process.env[name]).trim());
    if (missing.length) {
        throw new Error(`Missing required environment variables: ${missing.join(', ')}`);
    }

    if (String(process.env.JWT_SECRET).length < 32) {
        throw new Error('JWT_SECRET must be at least 32 characters long.');
    }
};

const parseAllowedOrigins = () =>
    (process.env.CORS_ORIGINS || process.env.FRONTEND_URL || '')
        .split(',')
        .map(origin => origin.trim())
        .filter(Boolean);

const allowedOrigins = parseAllowedOrigins();

const corsOptions = {
    origin(origin, callback) {
        if (!origin || allowedOrigins.length === 0 || allowedOrigins.includes(origin)) {
            return callback(null, true);
        }
        return callback(new Error('Origin is not allowed by CORS.'));
    },
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'Accept'],
    credentials: true,
    optionsSuccessStatus: 204
};

app.use(cors(corsOptions));

// Explicitly handle OPTIONS preflight for all routes
app.use(cors(corsOptions));

app.use(express.json({ limit: process.env.JSON_LIMIT || '10mb' }));
app.use(express.urlencoded({ extended: true, limit: process.env.JSON_LIMIT || '10mb' }));

const frontendPath = path.join(__dirname, '..', 'frontend');
app.use('/uploads', express.static(path.join(frontendPath, 'uploads')));
app.use(express.static(frontendPath));

app.use((req, res, next) => {
    const originalJson = res.json.bind(res);

    res.json = (body = {}) => {
        if (!body || typeof body !== 'object' || typeof body.success !== 'boolean') {
            return originalJson(body);
        }

        if (body.data === undefined) {
            const data = Object.entries(body)
                .filter(([key]) => !['success', 'message'].includes(key))
                .reduce((payload, [key, value]) => {
                    payload[key] = value;
                    return payload;
                }, {});
            body.data = Object.keys(data).length ? data : null;
        }

        return originalJson(body);
    };

    next();
});

app.use('/api/auth', require('./routes/authRoutes'));
app.use('/api', require('./routes/publicRoutes'));
app.use('/api', require('./routes/resourceRoutes'));
app.use('/api/admin', require('./routes/adminRoutes'));
app.use('/api/barber', require('./routes/barberRoutes'));
app.use('/api/staff', require('./routes/staffRoutes'));
app.use('/api/reservations', require('./routes/reservationRoutes'));

app.get('/api/health', (req, res) => {
    res.json({
        success: true,
        data: {
            status: 'ok',
            service: 'MenStation API',
            timestamp: new Date().toISOString()
        }
    });
});

app.get('/', (req, res) => {
    res.sendFile(path.join(frontendPath, 'index.html'));
});

app.use('/api', (req, res) => {
    res.status(404).json({
        success: false,
        message: 'API route not found.',
        data: null
    });
});

app.use((req, res) => {
    if (req.accepts('html')) {
        return res.sendFile(path.join(frontendPath, 'index.html'));
    }
    return res.status(404).json({
        success: false,
        message: 'Resource not found.',
        data: null
    });
});

app.use((err, req, res, next) => {
    logger.error('[SERVER ERROR]', err.message);
    res.status(err.status || 500).json({
        success: false,
        message: err.status && err.status < 500 ? err.message : 'Internal server error.',
        data: null
    });
});

const start = async () => {
    try {
        validateEnvironment();
        await ensureRequiredSchema();
    } catch (err) {
        logger.error('[STARTUP ERROR]', err.message);
        process.exit(1);
    }

    app.listen(PORT, () => {
        logger.info(`MenStation API listening on port ${PORT}`);
    });
};

if (require.main === module) {
    start();
}

module.exports = { app, start };
