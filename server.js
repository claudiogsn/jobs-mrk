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
const {gerarFilaWhatsapp} = require("./workers/WorkerDisparoFaturamento");

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

const formatDate = (dataISO) => {
    if (!dataISO) return '';
    const [ano, mes, dia] = dataISO.split('-');
    return `${dia}/${mes}/${ano}`;
};

// === Workers ===
router.post('/run/movimentocaixa', async (req, res) => {
    const { group_id, dt_inicio, dt_fim } = req.body;

    if (!group_id || !dt_inicio || !dt_fim) {
        return res.status(400).send('❌ Parâmetros obrigatórios ausentes: group_id, dt_inicio, dt_fim');
    }

    await processMovimentoCaixa({ group_id, dt_inicio, dt_fim });
    res.send(`✅ Worker - <strong>Movimento de Caixa</strong> executado com sucesso:<br><b>Grupo:</b> ${group_id}<br><b>Data:</b> ${formatDate(dt_inicio)} até ${formatDate(dt_fim)}`);
});

router.post('/run/itemvenda', async (req, res) => {
    const { group_id, dt_inicio, dt_fim } = req.body;

    if (!group_id || !dt_inicio || !dt_fim) {
        return res.status(400).send('❌ Parâmetros obrigatórios ausentes: group_id, dt_inicio, dt_fim');
    }

    await processItemVenda({ group_id, dt_inicio, dt_fim });
    res.send(`✅ Worker - <strong>Importação da API Menew</strong> executada com sucesso:<br><b>Grupo:</b> ${group_id}<br><b>Data:</b> ${formatDate(dt_inicio)} até ${formatDate(dt_fim)}`);
});

router.post('/run/consolidate', async (req, res) => {
    const { group_id, dt_inicio, dt_fim } = req.body;

    if (!group_id || !dt_inicio || !dt_fim) {
        return res.status(400).send('❌ Parâmetros obrigatórios ausentes: group_id, dt_inicio, dt_fim');
    }

    await processConsolidation({ group_id, dt_inicio, dt_fim });
    res.send(`✅ Worker - <strong>Sumarização das Vendas</strong> executada com sucesso:<br><b>Grupo:</b> ${group_id}<br><b>Data:</b> ${formatDate(dt_inicio)} até ${formatDate(dt_fim)}`);
});

router.post('/run/docsaida', async (req, res) => {
    const { group_id, data } = req.body;

    if (!group_id || !data) {
        return res.status(400).send('❌ Parâmetros obrigatórios ausentes: group_id, data');
    }

    await processDocSaida({ group_id, data });
    res.send(`✅ Worker - <strong>Baixa de Estoque</strong> executada com sucesso:<br><b>Grupo:</b> ${group_id}<br><b>Data:</b> ${formatDate(data)}`);
});

router.post('/run/financeiro', async (req, res) => {
    await dispatchFinanceiro();
    res.send('✅ Worker Financeiro iniciado.');
});

router.get('/run/wpp', async (req, res) => {
    await gerarFilaWhatsapp();
    res.send('✅ Worker Disparo Fatuiramento.');
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
