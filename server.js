require('dotenv').config();
const fs = require('fs');
const path = require('path');
const express = require('express');
const { getLogs,log} = require('./utils/logger');
const { processItemVenda } = require('./workers/workerItemVenda');
const { processConsolidation } = require('./workers/workerConsolidateSales');
const { processMovimentoCaixa } = require('./workers/workerMovimentoCaixa');
const { processDocSaida } = require('./workers/workerCreateDocSaida');
const { dispatchFinanceiro } = require('./workers/workerFinanceiro');
const { DateTime } = require('luxon');
const { SendReportPdfWithResumo } = require('./workers/WorkerSendReportPdfWeekly');
const { agendarJobsDinamicos } = require('./cron/agendador');
const { enviarResumoParaContato } = require('./workers/WorkerReport');
const { enviarResumoDiario, WorkerResumoDiario } = require('./workers/WorkerDisparoFaturamento');
const { processJobCaixaZig } = require('./workers/workerBillingZig');





const app = express();
const router = express.Router();


const PORT = process.env.PORT || 3005;

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


const liveLogs = [];
const MAX_LOGS = 1000;
const originalLog = console.log;

console.log = (...args) => {
    const timestamp = new Date().toLocaleString('pt-BR', {
        timeZone: 'America/Fortaleza',
        hour12: false
    }).replace(',', '');

    const msg = `[${timestamp}] ${args.join(' ')}`;
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

router.post('/run/billingzig', async (req, res) => {
    const { group_id, dt_inicio, dt_fim } = req.body;

    if (!group_id || !dt_inicio || !dt_fim) {
        return res.status(400).send('❌ Parâmetros obrigatórios: group_id, dt_inicio, dt_fim');
    }

    try {
        await processJobCaixaZig(group_id, dt_inicio, dt_fim);

        res.send(`✅ Faturamento Zig executado com sucesso para o grupo ${group_id} de ${formatDate(dt_inicio)} até ${formatDate(dt_fim)}`);
    } catch (err) {
        log(`❌ Erro ao executar processJobCaixaZig: ${err.message}`, 'ExpressServer');
        res.status(500).send('❌ Erro ao executar o faturamento Zig.');
    }
});

router.post('/run/consolidate', async (req, res) => {
    const { group_id, dt_inicio, dt_fim } = req.body;

    if (!group_id || !dt_inicio || !dt_fim) {
        return res.status(400).send('❌ Parâmetros obrigatórios ausentes: group_id, dt_inicio, dt_fim');
    }

    await processConsolidation(group_id, dt_inicio, dt_fim);
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

// === Workers de Resumo ===

router.post('/run/wpp-diario', async (req, res) => {
    await WorkerResumoDiario();
    res.send('✅ Worker Disparo Fatuiramento.');
});

router.post('/run/wpp-semanal', async (req, res) => {
    try {
        await SendReportPdfWithResumo();
        res.send('✅ Disparo de PDF semanal executado com sucesso.');
    } catch (err) {
        log(`❌ Erro ao executar WorkerSendReportPdfWeekly: ${err.message}`, 'ExpressServer');
        res.status(500).send('❌ Erro ao executar o disparo de PDF semanal.');
    }
});

router.post('/run/resumo-semanal', async (req, res) => {
    const { contato, grupo } = req.body;

    if (!contato?.nome || !contato?.telefone || !grupo?.id || !grupo?.nome) {
        return res.status(400).send('❌ Parâmetros obrigatórios: contato {nome, telefone}, grupo {id, nome}');
    }

    try {
        await enviarResumoParaContato(contato, grupo);
        res.send(`✅ Resumo enviado para ${contato.nome} / Grupo ${grupo.nome}`);
    } catch (err) {
        log(`❌ Erro ao enviar resumo manual: ${err.message}`, 'ExpressServer');
        res.status(500).send('❌ Erro ao enviar resumo.');
    }
});

router.post('/run/resumo-diario', async (req, res) => {
    const { contato, grupo } = req.body;

    if (!contato?.nome || !contato?.telefone || !grupo?.id || !grupo?.nome) {
        return res.status(400).send('❌ Parâmetros obrigatórios: contato {nome, telefone}, grupo {id, nome}');
    }

    try {
        await enviarResumoDiario(contato, grupo);
        res.send(`✅ Resumo enviado para ${contato.nome} / Grupo ${grupo.nome}`);
    } catch (err) {
        log(`❌ Erro ao enviar resumo manual: ${err.message}`, 'ExpressServer');
        res.status(500).send('❌ Erro ao enviar resumo.');
    }
});

// === Jobs Dinâmicos ===

router.post('/reload-cron', async (req, res) => {
    try {
        await agendarJobsDinamicos();
        res.send('🔄 Jobs recarregados com sucesso!');
    } catch (err) {
        log(`❌ Erro ao recarregar jobs: ${err.message}`, 'CronJob');
        res.status(500).send('Erro ao recarregar jobs.');
    }
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
    log(`🟢 Servidor iniciado na porta ${PORT}`, 'ExpressServer');
});
