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

async function callPHP(method, data) {
    const payload = { method, data };

    if (['itemVendaPayload', 'persistSales','persistMovimentoCaixa'].includes(method)) {
        appendApiLog(`➡️ REQUEST: ${method} - Grande Demais - Payload não logado por segurança`);
    } else {
        appendApiLog(`➡️ REQUEST: ${method} - ${JSON.stringify(payload)} - URL: ${process.env.BACKEND_URL}`);
    }

    try {
        const response = await axios.post(process.env.BACKEND_URL, payload);
        appendApiLog(`✅ RESPONSE (${method}): ${JSON.stringify(response.data)} - URL: ${process.env.BACKEND_URL}`);
        return response.data;
    } catch (error) {
        const errorContent = error.response?.data || error.message || 'Erro desconhecido';
        appendApiLog(`❌ ERROR (${method}): ${JSON.stringify(errorContent)} - URL: ${process.env.BACKEND_URL}`);
        return null;
    }
}


async function getZig(endpoint, lojaId, dtinicio, dtfim, tokenZig) {
    const url = `${process.env.ZIG_URL_INTEGRATION}/${endpoint}?dtinicio=${dtinicio}&dtfim=${dtfim}&loja=${lojaId}`;

    appendApiLog(`➡️ REQ Zig [${lojaId}] [${endpoint}]: ${url}`);

    try {
        const res = await axios.get(url, {
            headers: {
                Authorization: tokenZig
            }
        });

        const logBody = JSON.stringify(res.data);
        appendApiLog(`✅ RES Zig [${lojaId}] [${endpoint}]: ${logBody.length > 1000 ? logBody.substring(0, 1000) + '... [truncated]' : logBody}`);
        return res.data || [];
    } catch (err) {
        const errorData = err.response?.data || err.message || 'Erro desconhecido';
        appendApiLog(`❌ ERROR Zig [${lojaId}] [${endpoint}]: ${JSON.stringify(errorData)}`);
        return [];
    }
}

module.exports = {
    appendApiLog,
    callPHP,
    getZig
};
