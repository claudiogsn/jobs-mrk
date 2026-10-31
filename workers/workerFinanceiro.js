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

// Log das chamadas de API: stdout (CloudWatch), não mais logs/api.log em disco.
function appendApiLog(content) {
    log(content, 'workerFinanceiro');
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
