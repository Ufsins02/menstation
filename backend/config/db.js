const mysql = require('mysql2');
require('dotenv').config({ quiet: true });
const logger = require('../utils/logger');

const requireEnv = (name) => {
    const value = process.env[name];
    if (value === undefined || value === null || String(value).trim() === '') {
        throw new Error(`${name} is required. Set it in .env or in your deployment environment.`);
    }
    return value;
};

const pool = mysql.createPool({
    host: requireEnv('DB_HOST'),
    port: Number(process.env.DB_PORT || 3306),
    user: requireEnv('DB_USER'),
    password: process.env.DB_PASSWORD || '',
    database: requireEnv('DB_NAME'),
    waitForConnections: true,
    connectionLimit: Number(process.env.DB_CONNECTION_LIMIT || 10),
    queueLimit: 0,
    charset: 'utf8mb4'
});

const db = pool.promise();

if (process.env.NODE_ENV !== 'test') {
    pool.getConnection((err, connection) => {
        if (err) {
            logger.error('Database connection failed.');
            return;
        }
        logger.info('MySQL database connected.');
        connection.release();
    });
}

module.exports = db;
