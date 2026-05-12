require('dotenv').config();
const fs = require('fs');
const path = require('path');
const express = require('express');
const { getLogs,log} = require('./utils/logger');
const { sendWhatsappText} = require('./utils/utils');

const { processItemVenda } = require('./workers/workerItemVenda');
const { processConsolidation } = require('./workers/workerConsolidateSales');
const { processMovimentoCaixa } = require('./workers/workerMovimentoCaixa');
const { processDocSaida, ExecuteJobDocSaida } = require('./workers/workerCreateDocSaida');
const { dispatchFinanceiro } = require('./workers/workerFinanceiro');
const { processJobCaixaZig } = require('./workers/workerBillingZig');
const { ProcessJobStockZig, ExecuteJobStockZig} = require('./workers/workerStockZig');
const { processConsolidationStock } = require('./workers/WorkerConsolidationStock');

const { agendarJobsDinamicos } = require('./cron/agendador');

const { enviarResumoDiario, WorkerResumoDiario} = require('./workers/WorkerDisparoFaturamento');
const { enviarResumoSemanal, WorkerReportPdfWeekly } = require('./workers/WorkerReportPdfWeekly');
const { enviarResumoMensal, WorkerReportPdfMonthly } = require('./workers/WorkerReportPdfMonthly');
const {enviarNotasPendentes, WorkerNotasPendentes} = require('./workers/workerNotasPendentes');
const { enviarAuditoriaCop } = require('./workers/workerCopReport');
const { ProcessJobTransferNotify } = require('./workers/workerTransferNotify');
const { ExecuteJobSolicitacao } = require('./workers/workerSolicitacaoExtrato');
const { ExecuteJobImportacao } = require('./workers/workerImportacaoExtrato');




const { runSalesPipeline } = require('./workers/workerSalesPipeline');
const { ExecuteJobFluxoEstoque } = require('./workers/workerFluxoEstoque');
const {DateTime} = require("luxon");




const app = express();
const router = express.Router();
const PORT = process.env.PORT || 3005;
const liveLogs = [];
const MAX_LOGS = 1000;
const originalLog = console.log;
const REPORTS_DIR = path.join(__dirname, 'workers', 'reports');

app.use(express.json());


const formatDate = (dataISO) => {
    if (!dataISO) return '';
    const [ano, mes, dia] = dataISO.split('-');
    return `${dia}/${mes}/${ano}`;
};

router.use(express.json());

router.use('/assets', express.static(path.join(__dirname, 'assets')));

router.get('/favicon.ico', (req, res) => {
    res.sendFile(path.join(__dirname, 'assets/favicon.ico'));
});

router.get('/logo.png', (req, res) => {
    res.sendFile(path.join(__dirname, 'assets/logo.png'));
});

router.use('/reports', express.static(REPORTS_DIR));


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

// === API Explorer Dinâmico ===
router.get('/api/explorer-data', (req, res) => {
    try {
        // Lê o próprio arquivo server.js
        const content = fs.readFileSync(__filename, 'utf8');
        const routes = [];

        // Regex para encontrar router.post ou router.get
        const routeRegex = /router\.(post|get)\(\s*['"]([^'"]+)['"]/g;
        let match;

        while ((match = routeRegex.exec(content)) !== null) {
            const method = match[1].toUpperCase();
            const endpoint = match[2];

            // Pega um pedaço do código logo após a rota para analisar o body
            const chunk = content.slice(match.index, match.index + 300);
            let params = [];

            // Tenta encontrar a desestruturação do req.body (ex: const { param1, param2 } = req.body)
            const bodyMatch = chunk.match(/const\s+\{([^}]+)\}\s*=\s*req\.body/);
            if (bodyMatch) {
                params = bodyMatch[1]
                    .split(',')
                    .map(p => p.trim().split('=')[0].trim()) // Limpa espaços e valores default
                    .filter(p => p && !p.includes('\n'));
            }

            routes.push({ id: Math.random().toString(36).substring(7), method, endpoint, params });
        }

        res.json(routes);
    } catch (error) {
        res.status(500).json({ error: 'Erro ao ler as rotas: ' + error.message });
    }
});

// Rota para renderizar a página do dicionário
router.get('/explorer', (req, res) => {
    res.sendFile(path.join(__dirname, 'views/explorer.html'));
});

router.post('/api/extratos/sincronizar', async (req, res) => {
    console.log(JSON.stringify(req.body));
    try {

        const { system_unit_id, dt_inicio, dt_fim, user_id } = req.body;

        if (!system_unit_id) {
            return res.status(400).json({
                success: false,
                message: "O ID da unidade (system_unit_id) é obrigatório."
            });
        }


        const payloadWorker = {
            system_unit_id: Number(system_unit_id),
            dt_inicio: dt_inicio,
            dt_fim: dt_fim,
            user_id: user_id
        };


        ExecuteJobSolicitacao(payloadWorker)
            .then(() => console.log(`Job Manual de Extrato iniciado com sucesso para Unidade: ${system_unit_id}`))
            .catch(err => console.error(`Erro no Job Manual de Extrato:`, err));

        return res.status(200).json({
            success: true,
            message: "Sincronização de extratos solicitada! O processo está rodando em segundo plano."
        });

    } catch (error) {
        console.error("Erro ao chamar a rota de sincronização:", error);
        return res.status(500).json({
            success: false,
            message: "Erro interno no servidor ao tentar iniciar a sincronização."
        });
    }
});


router.post('/api/extratos/processar-pendentes', async (req, res) => {
    try {

        ExecuteJobImportacao()
            .then(() => console.log(`Job Manual de Importação finalizado com sucesso.`))
            .catch(err => console.error(`Erro no Job Manual de Importação:`, err));

        return res.status(200).json({
            success: true,
            message: "Verificação de extratos pendentes iniciada em background."
        });

    } catch (error) {
        console.error("Erro ao chamar a rota de processamento:", error);
        return res.status(500).json({
            success: false,
            message: "Erro interno no servidor ao tentar iniciar o processamento."
        });
    }
});

// === Workers ===
router.post('/notify/transferencia', async (req, res) => {
    const { system_unit_id, user_id, transfer_key } = req.body;

    if (!system_unit_id || !user_id || !transfer_key) {
        return res.status(400).send(
            '❌ Parâmetros obrigatórios: system_unit_id, user_id, transfer_key'
        );
    }

    try {
        await ProcessJobTransferNotify(system_unit_id, user_id, transfer_key);

        res.send('✅ Transferência processada e enviada com sucesso');
    } catch (err) {
        log(`❌ Erro ao executar ProcessJobTransferNotify: ${err.message}`, 'ExpressServer');
        res.status(500).send('❌ Erro ao processar transferência.');
    }
});
router.post('/run/resumo-diario', async (req, res) => {
    const { contato, grupo, data, dt_inicio, dt_fim } = req.body;

    if (
        !contato?.nome ||
        !contato?.telefone ||
        !grupo?.id ||
        !grupo?.nome
    ) {
        return res.status(400).send('❌ Parâmetros obrigatórios ausentes');
    }

    // Monta o array de datas a processar
    let datasParaEnviar = [];

    if (dt_inicio && dt_fim) {
        // Modo intervalo: gera todas as datas entre início e fim (inclusive)
        const inicio = new Date(dt_inicio + 'T00:00:00');
        const fim = new Date(dt_fim + 'T00:00:00');

        if (isNaN(inicio.getTime()) || isNaN(fim.getTime())) {
            return res.status(400).send('❌ Datas inválidas. Use o formato YYYY-MM-DD');
        }

        if (inicio > fim) {
            return res.status(400).send('❌ dt_inicio deve ser menor ou igual a dt_fim');
        }

        // Limite de segurança para não disparar centenas de mensagens por engano
        const diffDias = Math.ceil((fim - inicio) / (1000 * 60 * 60 * 24)) + 1;
        if (diffDias > 31) {
            return res.status(400).send(`❌ Intervalo muito grande (${diffDias} dias). Máximo permitido: 31 dias`);
        }

        const cursor = new Date(inicio);
        while (cursor <= fim) {
            const y = cursor.getFullYear();
            const m = String(cursor.getMonth() + 1).padStart(2, '0');
            const d = String(cursor.getDate()).padStart(2, '0');
            datasParaEnviar.push(`${y}-${m}-${d}`);
            cursor.setDate(cursor.getDate() + 1);
        }
    } else if (data) {
        // Modo data única (compatibilidade com o uso atual)
        datasParaEnviar.push(data);
    } else {
        // Sem data → usa o comportamento padrão (ontem, via getIntervalosDiarios)
        datasParaEnviar.push(null);
    }

    // Dispara um resumo para cada data
    const resultados = [];
    for (const dataDia of datasParaEnviar) {
        try {
            const enviado = await enviarResumoDiario(contato, grupo, dataDia);
            resultados.push({
                data: dataDia || 'padrão (ontem)',
                status: enviado ? 'enviado' : 'sem dados',
            });
        } catch (error) {
            console.error(`Erro no dia ${dataDia}:`, error);
            resultados.push({
                data: dataDia || 'padrão (ontem)',
                status: 'erro',
                erro: error.message,
            });
        }
    }

    const linhas = resultados
        .map(r => `• <b>${r.data}</b>: ${r.status}${r.erro ? ` (${r.erro})` : ''}`)
        .join('<br>');

    res.send(`✅ Worker - <strong>Resumo Diário</strong> processado:<br>
              <b>Cliente:</b> ${contato.nome}<br>
              <b>Grupo:</b> ${grupo.nome} (ID: ${grupo.id})<br>
              <b>Dias processados:</b> ${resultados.length}<br><br>
              ${linhas}`);
});

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

router.post('/run/stockzig', async (req, res) => {
    const { group_id, dt_inicio, dt_fim } = req.body;

    if (!group_id || !dt_inicio || !dt_fim) {
        return res.status(400).send('❌ Parâmetros obrigatórios: group_id, dt_inicio, dt_fim');
    }

    try {
        await ProcessJobStockZig(group_id, dt_inicio, dt_fim);

        res.send(`✅ Estoque Zig executado com sucesso para o grupo ${group_id} de ${formatDate(dt_inicio)} até ${formatDate(dt_fim)}`);
    } catch (err) {
        log(`❌ Erro ao executar processJobCaixaZig: ${err.message}`, 'ExpressServer');
        res.status(500).send('❌ Erro ao executar o faturamento Zig.');
    }
});

router.post('/run/grupoStockzig', async (req, res) => {
    const { group_id, dt_inicio, dt_fim } = req.body;

    if (!group_id || !dt_inicio || !dt_fim) {
        return res.status(400).send('❌ Parâmetros obrigatórios: group_id, dt_inicio, dt_fim');
    }

    try {
        await ExecuteJobStockZig(dt_inicio, dt_fim);

        res.send(`✅ Estoque Zig executado com sucesso para o grupo ${group_id} de ${formatDate(dt_inicio)} até ${formatDate(dt_fim)}`);
    } catch (err) {
        log(`❌ Erro ao executar processJobCaixaZig: ${err.message}`, 'ExpressServer');
        res.status(500).send('❌ Erro ao executar o faturamento Zig.');
    }
});

router.post('/run/grupoDocSaidaEstoque', async (req, res) => {
    const { group_id, dt_inicio, dt_fim } = req.body;

    if (!group_id || !dt_inicio || !dt_fim) {
        return res.status(400).send('❌ Parâmetros obrigatórios: group_id, dt_inicio, dt_fim');
    }

    try {
        await ExecuteJobDocSaida(dt_inicio, dt_fim,group_id);

        res.send(`✅ Estoque Zig executado com sucesso para o grupo ${group_id} de ${formatDate(dt_inicio)} até ${formatDate(dt_fim)}`);
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

router.post('/run/consolidacao-estoque', async (req, res) => {
    const { group_id, dt_inicio, dt_fim } = req.body;

    if (!group_id || !dt_inicio || !dt_fim) {
        return res
            .status(400)
            .send('❌ Parâmetros obrigatórios ausentes: group_id, dt_inicio, dt_fim');
    }

    try {
        const inicio = DateTime.fromISO(dt_inicio);
        const fim = DateTime.fromISO(dt_fim);

        if (!inicio.isValid || !fim.isValid) {
            return res.status(400).send('❌ Datas inválidas. Use formato YYYY-MM-DD.');
        }

        if (fim < inicio) {
            return res.status(400).send('❌ dt_fim não pode ser menor que dt_inicio.');
        }

        // diferença em dias, intervalo INCLUSIVO
        const diffDays = Math.floor(fim.diff(inicio, 'days').days) + 1;

        if (diffDays > 5) {
            return res
                .status(400)
                .send('❌ Período máximo permitido é de 5 dias (intervalo inclusivo).');
        }

        for (let i = 0; i < diffDays; i++) {
            const data_ref = inicio.plus({ days: i }).toFormat('yyyy-MM-dd');
            await processConsolidationStock({ group_id, data_ref });
        }

        return res.send(
            `✅ Consolidação de estoque executada para o grupo ${group_id} de ${dt_inicio} até ${dt_fim}`
        );
    } catch (err) {
        console.error(err);
        return res
            .status(500)
            .send(`❌ Erro ao executar consolidação de estoque: ${err.message}`);
    }
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

// === Workers de Whatsapp ===
router.post('/run/send-mensage', async (req, res) => {
    const { telefone, mensagem } = req.body;

    if (!telefone || !mensagem) {
        return res.status(400).send('❌ Parâmetros obrigatórios: telefone, mensagem');
    }

    try {
        await sendWhatsappText(telefone, mensagem);
        res.send(`✅ Mensagem enviada para ${telefone}`);
    } catch (err) {
        log(`❌ Erro ao enviar mensagem para ${telefone}: ${err.message}`, 'ExpressServer');
        res.status(500).send('❌ Erro ao enviar mensagem.');
    }
})
router.post('/run/wpp-diario', async (req, res) => {
    await WorkerResumoDiario();
    res.send('✅ Worker Disparo Fatuiramento.');
});

router.post('/run/wpp-semanal', async (req, res) => {
    try {
        await WorkerReportPdfWeekly();
        res.send('✅ Disparo de PDF semanal executado com sucesso.');
    } catch (err) {
        log(`❌ Erro ao executar WorkerReportPdfWeekly: ${err.message}`, 'ExpressServer');
        res.status(500).send('❌ Erro ao executar o disparo de PDF semanal.');
    }
});

router.post('/run/wpp-mensal', async (req, res) => {
    try {
        await WorkerReportPdfMonthly();
        res.send('✅ Disparo de PDF mensal executado com sucesso.');
    } catch (err) {
        log(`❌ Erro ao executar WorkerReportPdfMonthly: ${err.message}`, 'ExpressServer');
        res.status(500).send('❌ Erro ao executar o disparo de PDF semanal.');
    }
});

// router.post('/run/resumo-diario', async (req, res) => {
//     const { contato, grupo } = req.body;
//
//     if (!contato?.nome || !contato?.telefone || !grupo?.id || !grupo?.nome) {
//         return res.status(400).send('❌ Parâmetros obrigatórios: contato {nome, telefone}, grupo {id, nome}');
//     }
//
//     try {
//         await enviarResumoDiario(contato, grupo);
//         res.send(`✅ Resumo enviado para ${contato.nome} / Grupo ${grupo.nome}`);
//     } catch (err) {
//         log(`❌ Erro ao enviar resumo manual: ${err.message}`, 'ExpressServer');
//         res.status(500).send('❌ Erro ao enviar resumo.');
//     }
// });

router.post('/run/notas-pendentes', async (req, res) => {
    const { contato, grupo } = req.body;

    if (!contato?.nome || !contato?.telefone || !grupo?.id || !grupo?.nome) {
        return res.status(400).send('❌ Parâmetros obrigatórios: contato {nome, telefone}, grupo {id, nome}');
    }

    try {
        await enviarNotasPendentes(contato, grupo);
        res.send(`✅ Resumo enviado para ${contato.nome} / Grupo ${grupo.nome}`);
    } catch (err) {
        log(`❌ Erro ao enviar notas pendentes: ${err.message}`, 'ExpressServer');
        res.status(500).send('❌ Erro ao enviar resumo.');
    }
});

router.post('/run/send-cop', async (req, res) => {
    const { contato, grupo } = req.body;

    if (!contato?.nome || !contato?.telefone || !grupo?.id || !grupo?.nome) {
        return res.status(400).send('❌ Parâmetros obrigatórios: contato {nome, telefone}, grupo {id, nome}');
    }

    try {
        await enviarAuditoriaCop(contato, grupo);
        res.send(`✅ Resumo enviado para ${contato.nome} / Grupo ${grupo.nome}`);
    } catch (err) {
        log(`❌ Erro ao enviar cop: ${err.message}`, 'ExpressServer');
        res.status(500).send('❌ Erro ao enviar resumo.');
    }
});

router.post('/run/resumo-semanal', async (req, res) => {
    const { contato, grupo } = req.body;

    if (!contato?.nome || !contato?.telefone || !grupo?.id || !grupo?.nome) {
        return res.status(400).send('❌ Parâmetros obrigatórios: contato {nome, telefone}, grupo {id, nome}');
    }

    try {
        await enviarResumoSemanal(contato, grupo);
        res.send(`✅ Resumo enviado para ${contato.nome} / Grupo ${grupo.nome}`);
    } catch (err) {
        log(`❌ Erro ao enviar resumo manual: ${err.message}`, 'ExpressServer');
        res.status(500).send('❌ Erro ao enviar resumo.');
    }
});

router.post('/run/resumo-mensal', async (req, res) => {
    const { contato, grupo } = req.body;

    if (!contato?.nome || !contato?.telefone || !grupo?.id || !grupo?.nome) {
        return res.status(400).send('❌ Parâmetros obrigatórios: contato {nome, telefone}, grupo {id, nome}');
    }

    try {
        await enviarResumoMensal(contato, grupo);
        res.send(`✅ Resumo enviado para ${contato.nome} / Grupo ${grupo.nome}`);
    } catch (err) {
        log(`❌ Erro ao enviar resumo manual: ${err.message}`, 'ExpressServer');
        res.status(500).send('❌ Erro ao enviar resumo.');
    }
});

function isValidYMD(s) {
    return typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s);
}

router.post('/run/pipeline', async (req, res) => {
    const { group_id, dt_inicio, dt_fim } = req.body || {};

    if (!group_id || !dt_inicio || !dt_fim) {
        return res
            .status(400)
            .send('❌ Parâmetros obrigatórios ausentes: group_id, dt_inicio, dt_fim');
    }
    if (!isValidYMD(dt_inicio) || !isValidYMD(dt_fim)) {
        return res.status(400).send('❌ Formato de data inválido. Use YYYY-MM-DD.');
    }

    try {
        const result = await runSalesPipeline({ group_id, dt_inicio, dt_fim });
        const fmt = (d) => d.split('-').reverse().join('/');

        res.send(
            `✅ Pipeline executado com sucesso:<br>` +
            `<b>Grupo:</b> ${group_id}<br>` +
            `<b>Período:</b> ${fmt(dt_inicio)} até ${fmt(dt_fim)}`
        );
    } catch (err) {
        log(`❌ Erro no pipeline: ${err.message}`, 'ExpressServer');
        res.status(500).send('❌ Erro ao executar o pipeline.');
    }
});

router.post('/run/fluxo-estoque', async (req, res) => {
    const { group_id, unit_id, dt_inicio, dt_fim } = req.body;
    try {
        await ExecuteJobFluxoEstoque({ group: group_id, unit: unit_id, inicio: dt_inicio, fim: dt_fim });
        res.send(`Executado com sucesso`);
    } catch (err) {
        res.status(500).send("Erro ao executar fluxo de estoque");
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

router.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'views/dashboard.html'));
});

app.use('/jobs', router);

app.listen(PORT, () => {
    log(`🟢 Servidor iniciado na porta ${PORT}`, 'ExpressServer');
});
