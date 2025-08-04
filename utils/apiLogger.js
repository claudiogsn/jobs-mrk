// utils/apiLogger.js
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const axios = require('axios');

const LOG_DIR = path.resolve(__dirname, '../logs');
const LOG_PATH = path.resolve(LOG_DIR, 'api.log');

if (!fs.existsSync(LOG_DIR)) {
    fs.mkdirSync(LOG_DIR, { recursive: true });
}
if (!fs.existsSync(LOG_PATH)) {
    fs.writeFileSync(LOG_PATH, '');
}

function appendApiLog(content) {
    const timestamp = new Date().toISOString();
    const logEntry = `[${timestamp}] ${content}\n`;
    fs.appendFileSync(LOG_PATH, logEntry);
}



module.exports = {
    appendApiLog
};
