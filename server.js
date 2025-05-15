require('dotenv').config();
const fs = require('fs');
const path = require('path');
const express = require('express');
const { getLogs } = require('./utils/logger');
const { processItemVenda } = require('./workers/workerItemVenda');
const { processConsolidation } = require('./workers/workerConsolidateSales');
const { processMovimentoCaixa } = require('./workers/workerMovimentoCaixa');
const { processDocSaida } = require('./workers/workerCreateDocSaida');
const { dispatchFinanceiro } = require('./workers/workerFinanceiro');
const { DateTime } = require('luxon');

const app = express();
const router = express.Router();

const PORT = process.env.PORT || 3005;
const DEFAULT_GROUP_ID = process.env.GROUP_ID;

// middleware
router.use(express.json());
router.use('/assets', express.static(path.join(__dirname, 'assets')));

// favicon
router.get('/favicon.ico', (req, res) => {
    res.sendFile(path.join(__dirname, 'assets/favicon.ico'));
});

// logo
router.get('/logo.png', (req, res) => {
    res.sendFile(path.join(__dirname, 'assets/logo.png'));
});

// console.log wrapper
const liveLogs = [];
const MAX_LOGS = 1000;
const originalLog = console.log;
console.log = (...args) => {
    const msg = `[${new Date().toLocaleTimeString()}] ${args.join(' ')}`;
    liveLogs.push(msg);
    if (liveLogs.length > MAX_LOGS) liveLogs.shift();
    originalLog(msg);
};

const formatDate = (iso) => {
    return new Date(iso).toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo' });
};

// === Workers ===
router.post('/run/movimentocaixa', async (req, res) => {
    const group_id = req.body.group_id || DEFAULT_GROUP_ID;
    const dt_inicio = req.body.dt_inicio || DateTime.now().minus({ days: 1 }).toISODate();
    const dt_fim = req.body.dt_fim || dt_inicio;

    await processMovimentoCaixa({ group_id, dt_inicio, dt_fim });
    res.send(`✅ Worker - <strong>Movimento de Caixa</strong> executada com sucesso:<br><b>Grupo:</b> ${group_id}<br><b>Data:</b> ${formatDate(dt_inicio)}`);
});

router.post('/run/itemvenda', async (req, res) => {
    const group_id = req.body.group_id || DEFAULT_GROUP_ID;
    const dt_inicio = req.body.dt_inicio || DateTime.now().minus({ days: 1 }).toISODate();
    const dt_fim = req.body.dt_fim || dt_inicio;

    await processItemVenda({ group_id, dt_inicio, dt_fim });
    res.send(`✅ Worker - <strong>Importação da API Menew</strong> executada com sucesso:<br><b>Grupo:</b> ${group_id}<br><b>Data:</b> ${formatDate(dt_inicio)}`);
});

router.post('/run/consolidate', async (req, res) => {
    const group_id = req.body.group_id || DEFAULT_GROUP_ID;
    const dt_inicio = req.body.dt_inicio || DateTime.now().minus({ days: 1 }).toISODate();
    const dt_fim = req.body.dt_fim || dt_inicio;

    await processConsolidation({ group_id, dt_inicio, dt_fim });
    res.send(`✅ Worker - <strong>Sumarização das Vendas</strong> executada com sucesso:<br><b>Grupo:</b> ${group_id}<br><b>Data:</b> ${formatDate(dt_inicio)}`);
});

router.post('/run/docsaida', async (req, res) => {
    const group_id = req.body.group_id || DEFAULT_GROUP_ID;
    const data = req.body.data || DateTime.now().minus({ days: 1 }).toISODate();

    await processDocSaida({ group_id, data });
    res.send(`✅ Worker - <strong>Baixa de Estoque</strong> executada com sucesso:<br><b>Grupo:</b> ${group_id}<br><b>Data:</b> ${formatDate(data)}`);
});

router.post('/run/financeiro', async (req, res) => {
    await dispatchFinanceiro();
    res.send('✅ Worker Financeiro iniciado.');
});

// === Logs ===
router.get('/logs', (req, res) => {
    const logFilePath = path.resolve(__dirname, 'logs/api.log');
    fs.readFile(logFilePath, 'utf8', (err, data) => {
        if (err) return res.status(500).json({ error: 'Erro ao ler o arquivo de log.' });
        const lines = data.trim().split('\n');
        res.json(lines);
    });
});

router.get('/stdout', (req, res) => {
    res.json(liveLogs);
});

// === Autenticação ===
router.post('/auth', (req, res) => {
    const { usuario, senha } = req.body;
    const validUser = process.env.DASH_USER;
    const validPass = process.env.DASH_PASS;

    res.json({ success: usuario === validUser && senha === validPass });
});

// === Página HTML ===
router.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'views/dashboard.html'));
});

// ✅ aplica o router no prefixo /jobs
app.use('/jobs', router);

// inicia o servidor
app.listen(PORT, () => {
    console.log(`🟢 Servidor rodando em http://localhost:${PORT}/jobs`);
});
