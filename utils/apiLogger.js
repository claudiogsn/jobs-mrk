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

    if (['itemVendaPayload', 'persistSales','persistMovimentoCaixa'].includes(method)) {
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


async function getZigFaturamento(lojaId, dtinicio, dtfim, tokenZig) {
    const url = `https://api.zigcore.com.br/integration/erp/faturamento?dtinicio=${dtinicio}&dtfim=${dtfim}&loja=${lojaId}`;

    appendApiLog(`➡️ REQ Zig [${lojaId}]: ${url}`);

    try {
        const res = await axios.get(url, {
            headers: {
                Authorization: tokenZig
            }
        });

        const logBody = JSON.stringify(res.data);
        appendApiLog(`✅ RES Zig [${lojaId}]: ${logBody.length > 1000 ? logBody.substring(0, 1000) + '... [truncated]' : logBody}`);
        return res.data || [];
    } catch (err) {
        const errorData = err.response?.data || err.message || 'Erro desconhecido';
        appendApiLog(`❌ ERROR Zig [${lojaId}]: ${JSON.stringify(errorData)}`);
        return [];
    }
}

module.exports = {
    appendApiLog,
    callPHP,
    getZigFaturamento
};
