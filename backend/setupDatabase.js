require('dotenv').config({ quiet: true });

const fs = require('fs');
const path = require('path');
const mysql = require('mysql2/promise');

const required = (name) => {
    const value = process.env[name];
    if (!value || !String(value).trim()) {
        throw new Error(`${name} is required. Set it in .env first.`);
    }
    return String(value).trim();
};

const escapeIdentifier = (value) => {
    if (!/^[A-Za-z0-9_]+$/.test(value)) {
        throw new Error('DB_NAME may only contain letters, numbers, and underscores for schema setup.');
    }
    return `\`${value}\``;
};

const setupDatabase = async () => {
    const dbName = required('DB_NAME');
    const schemaPath = path.join(__dirname, '..', 'database', 'menstation.sql');
    const schema = fs.readFileSync(schemaPath, 'utf8')
        .replace(/CREATE DATABASE IF NOT EXISTS\s+menstation\s*;/i, `CREATE DATABASE IF NOT EXISTS ${escapeIdentifier(dbName)};`)
        .replace(/USE\s+menstation\s*;/i, `USE ${escapeIdentifier(dbName)};`);

    const connection = await mysql.createConnection({
        host: required('DB_HOST'),
        port: Number(process.env.DB_PORT || 3306),
        user: required('DB_USER'),
        password: process.env.DB_PASSWORD || '',
        multipleStatements: true
    });

    try {
        await connection.query(schema);
        console.log(`Database schema is ready: ${dbName}`);
    } finally {
        await connection.end();
    }
};

setupDatabase().catch((err) => {
    console.error(`[DB SETUP] ${err.message}`);
    process.exit(1);
});
