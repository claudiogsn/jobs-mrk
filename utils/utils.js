require('dotenv').config();
const { log } = require('../utils/logger');
const { DateTime } = require('luxon');
const axios = require('axios');
const { appendApiLog } = require('../utils/apiLogger');
const mysql = require("mysql2/promise");


function formatCurrency(value) {
    return 'R$ ' + (value || 0).toFixed(2)
        .replace('.', ',')
        .replace(/\B(?=(\d{3})+(?!\d))/g, '.');
}

function calcularVariacao(atual, anterior) {
    if (anterior === 0 && atual > 0) return `100% 🟢`;
    const percentual = ((atual - anterior) / anterior) * 100;
    if (isNaN(percentual) || !isFinite(percentual)) return '0% 🟠';
    return `${percentual.toFixed(2)}% ${percentual >= 0 ? '🟢' : '🔴'}`;
}

function calcularVariacaoSemBola(atual, anterior) {
    if (anterior === 0 && atual > 0) return `100%`;
    const percentual = ((atual - anterior) / anterior) * 100;
    if (isNaN(percentual) || !isFinite(percentual)) return '0%';
    return `${percentual.toFixed(2)}%`;
}

function calcularVariacaoReverse(atual, anterior) {
    if (anterior === 0 && atual < 0) return `100% 🟢`;
    const percentual = ((atual - anterior) / anterior) * 100;
    if (isNaN(percentual) || !isFinite(percentual)) return '0% 🟠';
    return `${percentual.toFixed(2)}% ${percentual <= 0 ? '🟢' : '🔴'}`;
}

function somarCampos(lista, campo) {
    return lista.reduce((acc, loja) => acc + (parseFloat(loja[campo]) || 0), 0);
}

async function callMenew(methodPayload, token) {
    try {
        const res = await axios.post(process.env.MENEW_URL, methodPayload, {
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${token}`
            }
        });
        appendApiLog(`✅ Menew call (${methodPayload?.requests?.method}): sucesso`);
        return res.data;
    } catch (err) {
        appendApiLog(`❌ ERROR (${methodPayload?.requests?.method}): ${JSON.stringify(err.response?.data || err.message)}`);
        return null;
    }
}

async function loginMenew() {
    const payload = {
        token: null,
        requests: {
            jsonrpc: '2.0',
            method: 'Usuario/login',
            params: {
                usuario: 'batech',
                token: 'X7K1g6VJLrcWPM2adw2O'
            },
            id: '1'
        }
    };

    try {
        const response = await axios.post(process.env.MENEW_URL, payload, {
            headers: { 'Content-Type': 'application/json' }
        });

        appendApiLog(`✅ Login Menew: sucesso - token recebido`);
        return response.data?.result || null;
    } catch (err) {
        appendApiLog(`❌ Erro ao fazer login na Menew: ${JSON.stringify(err.response?.data || err.message)}`);
        return null;
    }
}

async function callPHP(method, data) {
    const token = process.env.MRK_TOKEN;
    const payload = { method,token,data };

    if (['itemVendaPayload', 'persistSales','persistMovimentoCaixa'].includes(method)) {
        //appendApiLog(`➡️ REQUEST: ${method} - Grande Demais - Payload não logado por segurança`);
        appendApiLog(`➡️ REQUEST: ${method} - ${JSON.stringify(payload)} - URL: ${process.env.BACKEND_URL}`);
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

async function sendWhatsappText(telefone, mensagem) {
    try {
        await axios.post(
            `${process.env.ZAPI_BASE_URL}/instances/${process.env.ZAPI_INSTANCE_ID}/token/${process.env.ZAPI_INSTANCE_TOKEN}/send-text`,
            { phone: telefone, message: mensagem },
            { headers: { 'Content-Type': 'application/json', 'Client-Token': process.env.ZAPI_CLIENT_TOKEN } }
        );
        log(`📤 Texto enviado para ${telefone}`, 'WorkerReportPdfWeekly');
    } catch (err) {
        log(`❌ Erro ao enviar texto: ${err.message}`, 'WorkerReportPdfWeekly');
    }
}

async function sendWhatsappPdf(telefone, url) {
    const fileName = url.split('/').pop();
    try {
        await axios.post(
            `${process.env.ZAPI_BASE_URL}/instances/${process.env.ZAPI_INSTANCE_ID}/token/${process.env.ZAPI_INSTANCE_TOKEN}/send-document/pdf`,
            { phone: telefone, document: url, fileName },
            { headers: { 'Content-Type': 'application/json', 'Client-Token': process.env.ZAPI_CLIENT_TOKEN } }
        );
        log(`📎 PDF ${fileName} enviado para ${telefone}`, 'WorkerReportPdfWeekly');
    } catch (err) {
        log(`❌ Erro ao enviar PDF: ${err.message}`, 'WorkerReportPdfWeekly');
    }
}

async function getConnection() {
    return await mysql.createConnection({
        host: process.env.DB_HOST,
        user: process.env.DB_USER,
        password: process.env.DB_PASS,
        database: process.env.DB_NAME
    });
}


module.exports = {
    formatCurrency,
    calcularVariacao,
    somarCampos,
    callMenew,
    loginMenew,
    callPHP,
    getZig,
    sendWhatsappText,
    sendWhatsappPdf,
    getConnection,
    calcularVariacaoReverse,
    calcularVariacaoSemBola
    
};