// Worker: workerFinanceiro.js
require('dotenv').config();
const { log } = require('../utils/logger');
const axios = require('axios');
const fs = require('fs');
const path = require('path');

const ranges = [
    { start: 0, end: 10 },
    { start: 11, end: 20 },
    { start: 21, end: 30 }
];

const methods = [
    'importarRateiosApi',
    'importarClientesApi',
    'importarRecebiveisApi',
    'importarPagamentosApi',
    'importarContasReceberApi',
    'importarContasPagarApi',
    'importarFluxoCaixaApi',
    'importarSaldoContaApi'
];

const LOG_DIR = path.resolve(__dirname, '../logs');
const LOG_PATH = path.resolve(LOG_DIR, 'api.log');

// Cria diretório e arquivo se necessário
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
    const payload = {
        method,
        data
    };

    appendApiLog(`➡️ REQUEST: ${method} - ${JSON.stringify(payload)}`);

    try {
        const response = await axios.post(server,payload);

        appendApiLog(`✅ RESPONSE (${method}): ${JSON.stringify(response.data)}`);
        return response.data;

    } catch (error) {
        const errorContent = error.response?.data || error.message || 'Erro desconhecido';
        appendApiLog(`❌ ERROR (${method}): ${JSON.stringify(errorContent)}`);
        return null;
    }
}


async function processRange(start, end) {
    log(`🔁 Processando unidades de ${start} a ${end}`, 'workerFinanceiro');
    for (let unit_id = start; unit_id <= end; unit_id++) {
        for (const method of methods) {
            await callPHP(method, { unit_id });
        }
    }
}

async function dispatchFinanceiro() {
    while (true) {
        for (const range of ranges) {
            await processRange(range.start, range.end);
        }
        log('⏳ Aguardando 10 minutos...', 'workerFinanceiro');
        await new Promise(res => setTimeout(res, 10 * 60 * 1000));
    }
}

module.exports = { dispatchFinanceiro };

if (require.main === module) {
    dispatchFinanceiro();
}
