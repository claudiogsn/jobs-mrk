// utils/apiLogger.js
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

async function callPHP(method, data) {
    const payload = { method, data };

    if (['itemVendaPayload', 'persistSales'].includes(method)) {
        appendApiLog(`➡️ REQUEST: ${method} - Grande Demais`);
    } else {
        appendApiLog(`➡️ REQUEST: ${method} - ${JSON.stringify(payload)}`);
    }

    try {
        const response = await axios.post(process.env.BACKEND_URL, payload);
        appendApiLog(`✅ RESPONSE (${method}): ${JSON.stringify(response.data)}`);
        return response.data;
    } catch (error) {
        const errorContent = error.response?.data || error.message || 'Erro desconhecido';
        appendApiLog(`❌ ERROR (${method}): ${JSON.stringify(errorContent)}`);
        return null;
    }
}

module.exports = {
    appendApiLog,
    callPHP
};
