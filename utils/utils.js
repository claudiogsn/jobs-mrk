require('dotenv').config();
const { log } = require('../utils/logger');
const { getLogger } = require('@mrksolucoes/observability');
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
        appendApiLog('menew', `✅ Menew call (${methodPayload?.requests?.method}): ${JSON.stringify(res.data)}`);
        return res.data;
    } catch (err) {
        appendApiLog('menew', `❌ ERROR (${methodPayload?.requests?.method}): ${JSON.stringify(err.response?.data || err.message)}`);
        return null;
    }
}

const phpCache = new Map();
const CACHE_TTL_MS = 3 * 60 * 1000; // 3 minutos de TTL para requisições idênticas na mesma execução

async function callPHP(method, data) {
    const token = process.env.MRK_TOKEN;
    const payload = { method, token, data };

    // Apenas cacheia operações de leitura pura
    const isCacheable = method.startsWith('get') || method.startsWith('listar') || method.startsWith('generate');
    const cacheKey = `${method}:${JSON.stringify(data || {})}`;

    if (isCacheable && phpCache.has(cacheKey)) {
        const cached = phpCache.get(cacheKey);
        if (Date.now() - cached.timestamp < CACHE_TTL_MS) {
            appendApiLog('php_backend', `⚡ CACHE HIT (${method}): ${cacheKey}`);
            return cached.data;
        } else {
            phpCache.delete(cacheKey);
        }
    }

    appendApiLog('php_backend', `➡️ REQUEST: ${method} - ${JSON.stringify(payload)} - URL: ${process.env.BACKEND_URL}`);

    try {
        const response = await axios.post(process.env.BACKEND_URL, payload);
        appendApiLog('php_backend', `✅ RESPONSE (${method}): ${JSON.stringify(response.data)} - URL: ${process.env.BACKEND_URL}`);

        if (isCacheable && response && response.data) {
            phpCache.set(cacheKey, {
                timestamp: Date.now(),
                data: response.data
            });
        }

        return response.data;
    } catch (error) {
        const errorContent = error.response?.data || error.message || 'Erro desconhecido';
        appendApiLog('php_backend', `❌ ERROR (${method}): ${JSON.stringify(errorContent)} - URL: ${process.env.BACKEND_URL}`);
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

        appendApiLog('menew', `✅ Login Menew: sucesso - token recebido`);
        return response.data?.result || null;
    } catch (err) {
        appendApiLog('menew', `❌ Erro ao fazer login na Menew: ${JSON.stringify(err.response?.data || err.message)}`);
        return null;
    }
}

async function getZig(endpoint, lojaId, dtinicio, dtfim, tokenZig) {
    const url = `${process.env.ZIG_URL_INTEGRATION}/${endpoint}?dtinicio=${dtinicio}&dtfim=${dtfim}&loja=${lojaId}`;

    appendApiLog('zig', `➡️ REQ Zig [${lojaId}] [${endpoint}]: ${url}`);

    try {
        const res = await axios.get(url, {
            headers: {
                Authorization: tokenZig
            }
        });

        const logBody = JSON.stringify(res.data);
        appendApiLog('zig', `✅ RES Zig [${lojaId}] [${endpoint}]: ${logBody.length > 1000 ? logBody.substring(0, 1000) + '... [truncated]' : logBody}`);
        return res.data || [];
    } catch (err) {
        const errorData = err.response?.data || err.message || 'Erro desconhecido';
        appendApiLog('zig', `❌ ERROR Zig [${lojaId}] [${endpoint}]: ${JSON.stringify(errorData)}`);
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
        log(`📤 Texto enviado para ${telefone}`, 'sendWhatsappText');
    } catch (err) {
        log(`❌ Erro ao enviar texto: ${err.message}`, 'sendWhatsappText');
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
        log(`📎 PDF ${fileName} enviado para ${telefone}`, 'sendWhatsappPdf');
    } catch (err) {
        log(`❌ Erro ao enviar PDF: ${err.message}`, 'sendWhatsappPdf');
    }
}

let pool = null;

/** Pool de conexões singleton (criado sob demanda). */
function getPool() {
    if (!pool) {
        pool = mysql.createPool({
            host: process.env.DB_HOST,
            user: process.env.DB_USER,
            password: process.env.DB_PASS,
            database: process.env.DB_NAME,
            waitForConnections: true,
            connectionLimit: Number(process.env.DB_POOL_LIMIT || 10),
            queueLimit: 0,
            enableKeepAlive: true,
        });
    }
    return pool;
}

/**
 * Retorna uma conexão do pool.
 *
 * Compatibilidade: a base histórica faz `conn.end()` para liberar a conexão.
 * Numa pool connection o mysql2 já redireciona end()→release(), mas emitindo um
 * warning de deprecação a cada chamada. Sobrescrevemos `end` para devolver ao pool
 * silenciosamente — assim nenhum dos ~18 chamadores precisa mudar.
 */
async function getConnection() {
    const conn = await getPool().getConnection();
    conn.end = conn.release.bind(conn);
    return conn;
}

async function callTecnoSpeed(systemUnitId, axiosConfig) {
    const startTime = Date.now();
    let httpCode = null;
    let responseBody = null;
    let errorMessage = null;
    let result = null;
    let errorToThrow = null;

    const finalConfig = {
        ...axiosConfig,
        headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            ...axiosConfig.headers,
        }
    };

    // LOG DE REQUEST (NOVO - Arquivo)
    const method = (finalConfig.method || 'GET').toUpperCase();
    appendApiLog('tecnospeed', `➡️ REQUEST: ${method} - ${JSON.stringify(finalConfig.data || {})} - URL: ${finalConfig.url}`);

    try {
        // 1. Executa a chamada real para a API
        const response = await axios(finalConfig);
        httpCode = response.status;

        const rawResponse = JSON.stringify(response.data);
        responseBody = rawResponse.length > 50000 ? rawResponse.substring(0, 50000) + '... [TRUNCADO]' : rawResponse;

        result = response;

        // LOG DE SUCESSO (NOVO - Arquivo)
        appendApiLog('tecnospeed', `✅ RESPONSE HTTP ${httpCode} - URL: ${finalConfig.url} - BODY: ${rawResponse.substring(0, 1000)}`);

    } catch (error) {
        httpCode = error.response ? error.response.status : null;
        responseBody = error.response ? JSON.stringify(error.response.data) : null;
        errorMessage = error.message || 'Erro desconhecido';
        errorToThrow = error;

        // LOG DE ERRO (NOVO - Arquivo)
        appendApiLog('tecnospeed', `❌ ERROR HTTP ${httpCode} - ${errorMessage} - DETAILS: ${responseBody} - URL: ${finalConfig.url}`);
    }

    const executionTimeMs = Date.now() - startTime;

    // Lógica de salvar no Banco de Dados mantida intacta
    let conn = null;
    try {
        conn = await getConnection();

        const reqBodyLog = finalConfig.data ? JSON.stringify(finalConfig.data) : null;

        let endpointLog = finalConfig.url;
        if (finalConfig.url.length > 255) {
            endpointLog = finalConfig.url.substring(0, 250) + '...';
        }

        await conn.execute(`
            INSERT INTO pluggy_integration_logs
            (system_unit_id, endpoint, method, request_body, response_body, http_code, error_message, execution_time_ms)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `, [
            systemUnitId,
            endpointLog,
            method,
            reqBodyLog,
            responseBody,
            httpCode,
            errorMessage,
            executionTimeMs
        ]);
    } catch (logError) {
        getLogger().error(logError, { contexto: 'salvar log de integração Tecnospeed no BD' });
    } finally {
        if (conn) await conn.end();
    }

    if (errorToThrow) {
        throw errorToThrow;
    }

    return result;
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
    getPool,
    calcularVariacaoReverse,
    calcularVariacaoSemBola,
    callTecnoSpeed
};