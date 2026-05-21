const isProduction = process.env.NODE_ENV === 'production';

const logger = {
    info: (...args) => {
        if (!isProduction) console.info(...args);
    },
    warn: (...args) => {
        if (!isProduction) console.warn(...args);
    },
    error: (...args) => {
        console.error(...args);
    }
};

module.exports = logger;
