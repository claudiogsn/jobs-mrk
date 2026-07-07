require('dotenv').config();
const fs = require('fs');
const path = require('path');
const express = require('express');
const { getLogs,log} = require('./utils/logger');
const { getLogger, requestContextMiddleware } = require('@mrksolucoes/observability');
const { sendWhatsappText, getConnection } = require('./utils/utils');
const { appendApiLog } = require('./utils/apiLogger');
const axios = require('axios');

const logger = getLogger();

const { processItemVenda } = require('./workers/workerItemVenda');
const { processConsolidation } = require('./workers/workerConsolidateSales');
const { processMovimentoCaixa } = require('./workers/workerMovimentoCaixa');
const { processDocSaida, ExecuteJobDocSaida } = require('./workers/workerCreateDocSaida');
const { dispatchFinanceiro } = require('./workers/workerFinanceiro');
const { processJobCaixaZig } = require('./workers/workerBillingZig');
const { ProcessJobStockZig, ExecuteJobStockZig} = require('./workers/workerStockZig');
const { processConsolidationStock } = require('./workers/WorkerConsolidationStock');
const { ExecuteJob3lmEstoque } = require('./workers/worker3lmEstoque');

const { publishFanout, EXCHANGES } = require('./utils/rabbitmq');

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
const REPORTS_DIR = path.join(__dirname, 'workers', 'reports');

app.use(express.json());
// Contexto de requisição: requestId/correlationId + trace/span + log de entrada/saída.
app.use(requestContextMiddleware);


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
    logger.debug('Sincronização de extratos: body recebido', { body: req.body });
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
            .then(() => logger.info(`Job Manual de Extrato iniciado para Unidade: ${system_unit_id}`, { system_unit_id }))
            .catch(err => logger.error(err, { rota: '/api/extratos/sincronizar', system_unit_id }));

        return res.status(200).json({
            success: true,
            message: "Sincronização de extratos solicitada! O processo está rodando em segundo plano."
        });

    } catch (error) {
        logger.error(error, { rota: '/api/extratos/sincronizar' });
        return res.status(500).json({
            success: false,
            message: "Erro interno no servidor ao tentar iniciar a sincronização."
        });
    }
});

router.get('/api/analise-menew/unidades', async (req, res) => {
    try {
        const conn = await getConnection();
        const [units] = await conn.execute(
            "SELECT id, name, custom_code FROM system_unit WHERE status = 1 AND custom_code IS NOT NULL AND custom_code != '' ORDER BY name"
        );
        conn.end();
        res.json(units);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

router.get('/analise-menew', (req, res) => {
    res.sendFile(path.join(__dirname, 'views/analise_menew.html'));
});

router.get('/doc-menew', (req, res) => {
    res.sendFile(path.join(__dirname, 'views/doc_endpoints_menew.html'));
});

router.post('/api/analise-menew/cruzamento', async (req, res) => {
    try {
        const { system_unit_id, data } = req.body;

        if (!system_unit_id || !data) {
            return res.status(400).json({ success: false, message: 'Parâmetros system_unit_id e data são obrigatórios.' });
        }

        const conn = await getConnection();

        // 1. Busca custom_code da loja
        const [units] = await conn.execute("SELECT name, custom_code FROM system_unit WHERE id = ? LIMIT 1", [system_unit_id]);
        if (units.length === 0) {
            conn.end();
            return res.status(404).json({ success: false, message: 'Unidade não encontrada.' });
        }

        const customCode = units[0].custom_code;
        const nomeLoja = units[0].name;

        if (!customCode) {
            conn.end();
            return res.status(400).json({ success: false, message: 'Unidade sem código de integração da Menew configurado.' });
        }

        // 2. Login na Menew
        const { loginMenew, callMenew } = require('./utils/utils');
        const authToken = await loginMenew();
        if (!authToken) {
            conn.end();
            return res.status(500).json({ success: false, message: 'Falha na autenticação com a API Menew.' });
        }

        const dataRef = data; // Formato YYYY-MM-DD
        const dataRefFechamento = DateTime.fromISO(dataRef).toFormat('dd/MM/yyyy');

        // 3. Chamadas em paralelo para API da Menew
        const [apiMov, apiPag, apiItem, apiFech] = await Promise.all([
            callMenew({ token: authToken, requests: { jsonrpc: '2.0', method: 'movimentocaixa', params: { lojas: customCode, dtinicio: dataRef, dtfim: dataRef }, id: '1' } }, authToken),
            callMenew({ token: authToken, requests: { jsonrpc: '2.0', method: 'pagamentos', params: { lojas: customCode, dtinicio: dataRef, dtfim: dataRef }, id: '1' } }, authToken),
            callMenew({ token: authToken, requests: { jsonrpc: '2.0', method: 'itemvenda', params: { lojas: customCode, dtinicio: dataRef, dtfim: dataRef }, id: '1' } }, authToken),
            callMenew({ token: authToken, requests: { jsonrpc: '2.0', method: 'fechamentocaixa', params: { lojas: customCode, dtinicio: dataRef, dtfim: dataRef }, id: '1' } }, authToken)
        ]);

        // 4. Chamadas em paralelo para o banco de dados local
        const [dbMovRows] = await conn.execute("SELECT id, num_controle, vlTotalReceber, vlTotalRecebido, vlDesconto FROM movimento_caixa WHERE lojaId = ? AND dataContabil = ?", [customCode, dataRef]);
        const [dbPagRows] = await conn.execute("SELECT id_operacao, descricao, valor FROM api_pagamentos WHERE id_loja = ? AND data_contabil = ?", [customCode, dataRef]);
        const [dbSalesRows] = await conn.execute("SELECT idItemVenda, valorBruto, valorLiquido, codMaterial, descricao, __nfNumeroC, dtLancamento FROM sales WHERE system_unit_id = ? AND dtLancamento LIKE ?", [system_unit_id, dataRef + '%']);
        const [dbFechRows] = await conn.execute("SELECT uuid, dinheiro_computado, cartao_computado FROM api_fechamento_caixa WHERE id_estabelecimento = ? AND movimento = ?", [customCode, dataRefFechamento]);

        let dbFechOutrosRows = [];
        let dbFechCartoesRows = [];
        if (dbFechRows.length > 0) {
            const [outros] = await conn.execute("SELECT descricao, valor FROM api_fechamento_outros WHERE fechamento_uuid = ?", [dbFechRows[0].uuid]);
            const [cartoes] = await conn.execute("SELECT descricao, vl_sistema FROM api_fechamento_cartoes WHERE fechamento_uuid = ?", [dbFechRows[0].uuid]);
            dbFechOutrosRows = outros;
            dbFechCartoesRows = cartoes;
        }

        conn.end();

        // 5. Consolidação de Totais e Contagens
        const totalApiMov = { receber: 0, recebido: 0, count: apiMov?.result?.length || 0 };
        if (apiMov?.result) {
            apiMov.result.forEach(m => {
                totalApiMov.receber += parseFloat(m.vlTotalReceber || 0);
                totalApiMov.recebido += parseFloat(m.vlTotalRecebido || 0);
            });
        }
        totalApiMov.receber = Math.round(totalApiMov.receber * 100) / 100;
        totalApiMov.recebido = Math.round(totalApiMov.recebido * 100) / 100;

        const totalApiPag = { valor: 0, count: apiPag?.result?.length || 0, formas: {} };
        if (apiPag?.result) {
            apiPag.result.forEach(p => {
                const val = parseFloat(p.valor || 0);
                totalApiPag.valor += val;
                totalApiPag.formas[p.descricao] = (totalApiPag.formas[p.descricao] || 0) + val;
            });
        }
        totalApiPag.valor = Math.round(totalApiPag.valor * 100) / 100;
        for (const f in totalApiPag.formas) {
            totalApiPag.formas[f] = Math.round(totalApiPag.formas[f] * 100) / 100;
        }

        const totalApiItem = { bruto: 0, liquido: 0, count: apiItem?.result?.length || 0 };
        if (apiItem?.result) {
            apiItem.result.forEach(i => {
                totalApiItem.bruto += parseFloat(i.valorBruto || 0);
                totalApiItem.liquido += parseFloat(i.valorLiquido || 0);
            });
        }
        totalApiItem.bruto = Math.round(totalApiItem.bruto * 100) / 100;
        totalApiItem.liquido = Math.round(totalApiItem.liquido * 100) / 100;

        const totalDbMov = { receber: 0, recebido: 0, count: dbMovRows.length };
        dbMovRows.forEach(m => {
            totalDbMov.receber += parseFloat(m.vlTotalReceber || 0);
            totalDbMov.recebido += parseFloat(m.vlTotalRecebido || 0);
        });
        totalDbMov.receber = Math.round(totalDbMov.receber * 100) / 100;
        totalDbMov.recebido = Math.round(totalDbMov.recebido * 100) / 100;

        const totalDbPag = { valor: 0, count: dbPagRows.length, formas: {} };
        dbPagRows.forEach(p => {
            const val = parseFloat(p.valor || 0);
            totalDbPag.valor += val;
            totalDbPag.formas[p.descricao] = (totalDbPag.formas[p.descricao] || 0) + val;
        });
        totalDbPag.valor = Math.round(totalDbPag.valor * 100) / 100;
        for (const f in totalDbPag.formas) {
            totalDbPag.formas[f] = Math.round(totalDbPag.formas[f] * 100) / 100;
        }

        const totalDbItem = { bruto: 0, liquido: 0, count: dbSalesRows.length };
        dbSalesRows.forEach(i => {
            totalDbItem.bruto += parseFloat(i.valorBruto || 0);
            totalDbItem.liquido += parseFloat(i.valorLiquido || 0);
        });
        totalDbItem.bruto = Math.round(totalDbItem.bruto * 100) / 100;
        totalDbItem.liquido = Math.round(totalDbItem.liquido * 100) / 100;

        // 6. Fechamentos consolidados
        const fechamentoFormatado = [];
        if (apiFech?.result) {
            apiFech.result.forEach(f => {
                const formasFechamento = {};
                if (f.cartao_detalhado) {
                    f.cartao_detalhado.forEach(c => {
                        formasFechamento[c.descricao] = Math.round(parseFloat(c.vl_sistema || 0) * 100) / 100;
                    });
                }
                if (f.outros_pagamentos) {
                    f.outros_pagamentos.forEach(o => {
                        // Limpa "OUTROS - " do nome se houver
                        const desc = o.descricao.replace('OUTROS - ', '');
                        formasFechamento[desc] = Math.round(parseFloat(o.valor || 0) * 100) / 100;
                    });
                }
                if (parseFloat(f.dinheiro_computado) > 0) {
                    formasFechamento['DINHEIRO'] = Math.round(parseFloat(f.dinheiro_computado || 0) * 100) / 100;
                }

                fechamentoFormatado.push({
                    operador: f.operador,
                    abertura: f.data_hora_abertura,
                    fechamento: f.data_hora_fechamento,
                    dinheiro: parseFloat(f.dinheiro_computado || 0),
                    cartao: parseFloat(f.cartao_computado || 0),
                    formas: formasFechamento
                });
            });
        }

        // 7. Diagnósticos e Auditorias de Omissão
        const omissoes = [];
        fechamentoFormatado.forEach(f => {
            for (const [forma, valorFech] of Object.entries(f.formas)) {
                // Compara com as vendas brutas de pagamentos na API
                const valorApi = totalApiPag.formas[forma] || 0;
                // Margem de tolerância de R$ 1,00 para arredondamentos
                if (valorFech > valorApi + 1.0) {
                    omissoes.push({
                        forma: forma,
                        valorFechamento: valorFech,
                        valorApiPagamentos: valorApi,
                        diferenca: valorFech - valorApi,
                        mensagem: `A forma '${forma}' tem R$ ${valorFech.toFixed(2)} no fechamento, mas apenas R$ ${valorApi.toFixed(2)} veio detalhado nos pagamentos da API.`
                    });
                }
            }
        });

        // 8. Diagnósticos de Duplicidades e Reutilização de num_controle
        const alertasDuplicidade = [];
        
        // Verifica num_controle duplicados na API
        const numControleMap = {};
        if (apiMov?.result) {
            apiMov.result.forEach(m => {
                const nc = m.numControle || m.idMovimentoCaixa;
                if (!numControleMap[nc]) {
                    numControleMap[nc] = [];
                }
                numControleMap[nc].push(m);
            });

            for (const [nc, list] of Object.entries(numControleMap)) {
                if (list.length > 1) {
                    alertasDuplicidade.push({
                        tipo: 'num_controle_reutilizado',
                        chave: nc,
                        detalhes: list.map(item => `Movimento ID ${item.idMovimentoCaixa} (Abertura: ${item.dataAbertura}, Recebido: R$ ${item.vlTotalRecebido})`),
                        mensagem: `O número de controle/operação '${nc}' se repete ${list.length} vezes nos caixas deste dia na API da Menew.`
                    });
                }
            }
        }

        // Verifica itens duplicados em sales (contingência)
        const notasItensMap = {};
        dbSalesRows.forEach(item => {
            const nota = item.__nfNumeroC || 'SemNota';
            const chave = `${nota}-${item.codMaterial}-${item.valorLiquido}`;
            if (!notasItensMap[chave]) {
                notasItensMap[chave] = [];
            }
            notasItensMap[chave].push(item);
        });

        for (const [chave, list] of Object.entries(notasItensMap)) {
            if (list.length > 1) {
                const [nota, cod, val] = chave.split('-');
                alertasDuplicidade.push({
                    tipo: 'itens_duplicados_contingencia',
                    chave: chave,
                    detalhes: list.map(item => `Item: ${item.descricao} (ID Venda: ${item.idItemVenda}, Lançamento: ${item.dtLancamento})`),
                    mensagem: `Nota Fiscal ${nota}: O produto código ${cod} no valor de R$ ${parseFloat(val).toFixed(2)} está duplicado ${list.length} vezes no banco local.`
                });
            }
        }

        res.json({
            success: true,
            meta: {
                system_unit_id,
                customCode,
                nomeLoja,
                dataRef
            },
            totais: {
                api: {
                    movimento: totalApiMov,
                    pagamentos: totalApiPag,
                    itens: totalApiItem,
                },
                local: {
                    movimento: totalDbMov,
                    pagamentos: totalDbPag,
                    itens: totalDbItem
                }
            },
            fechamento: fechamentoFormatado,
            auditoria: {
                omissoes,
                alertasDuplicidade
            }
        });

    } catch (error) {
        logger.error(error, { rota: '/api/analise-menew/cruzamento' });
        res.status(500).json({ success: false, message: 'Erro ao processar análise: ' + error.message });
    }
});

router.post('/api/extratos/processar-pendentes', async (req, res) => {
    try {

        ExecuteJobImportacao()
            .then(() => logger.info('Job Manual de Importação finalizado com sucesso.'))
            .catch(err => logger.error(err, { rota: '/api/extratos/processar-pendentes' }));

        return res.status(200).json({
            success: true,
            message: "Verificação de extratos pendentes iniciada em background."
        });

    } catch (error) {
        logger.error(error, { rota: '/api/extratos/processar-pendentes' });
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
            logger.error(error, { rota: '/run/resumo-diario', dia: dataDia });
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
        logger.error(err, { rota: '/run/consolidacao-estoque', group_id });
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

router.post('/run/3lm-estoque', async (req, res) => {
    const { dt_inicio, dt_fim } = req.body;
    try {
        await ExecuteJob3lmEstoque(dt_inicio, dt_fim);
        res.send("ExecuteJob3lmEstoque executado com sucesso");
    } catch (err) {
        res.status(500).send("Erro ao executar ExecuteJob3lmEstoque: " + err.message);
    }
});

// === Jobs Dinâmicos ===
router.post('/reload-cron', async (req, res) => {
    try {
        // Sinaliza o scheduler (mesmo processo ou processo separado) via fanout.
        await publishFanout(EXCHANGES.CRON_RELOAD, { at: Date.now() });
        res.send('🔄 Sinal de reload enviado ao agendador!');
    } catch (err) {
        log(`❌ Erro ao sinalizar reload de jobs: ${err.message}`, 'CronJob');
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
    res.json(getLogs());
});

// === Autenticação ===
router.post('/auth', (req, res) => {
    const { usuario, senha } = req.body;
    const validUser = process.env.DASH_USER;
    const validPass = process.env.DASH_PASS;

    res.json({ success: usuario === validUser && senha === validPass });
});

// ============================================================
// iFood — Gestão de Credenciais
// ============================================================

const ifoodPendingAuth = new Map();

// Helper: loga req/resp do iFood em logs/ifood.log
function ifoodLog(label, data) {
    const safe = JSON.stringify(data, null, 2);
    appendApiLog('ifood', `${label}\n${safe}`);
}

// Wrapper axios para iFood com log completo
async function ifoodAxios(config) {
    config.method = config.method || 'GET';
    const label = `➡️  ${config.method.toUpperCase()} ${config.url}`;
    ifoodLog(label, {
        params:  config.params  || null,
        headers: config.headers || null,
        body:    config.data    || null,
    });
    try {
        const resp = await axios(config);
        ifoodLog(`✅ HTTP ${resp.status} ← ${config.url}`, resp.data);
        return resp;
    } catch (err) {
        ifoodLog(`❌ HTTP ${err.response?.status ?? 'NETWORK'} ← ${config.url}`, {
            status:  err.response?.status,
            headers: err.response?.headers,
            body:    err.response?.data,
            message: err.message,
        });
        throw err;
    }
}

router.get('/api/ifood/empresas', async (req, res) => {
    const conn = await getConnection();
    try {
        const [rows] = await conn.execute(`
            SELECT su.id, su.name, su.cnpj,
                   ic.id            AS credencial_id,
                   ic.merchant_id,
                   ic.merchant_nome,
                   ic.status        AS ifood_status,
                   ic.ambiente,
                   ic.conectada_em,
                   ic.ultimo_erro
            FROM system_unit su
            LEFT JOIN ifood_credenciais ic ON ic.empresa_id = su.id
            WHERE su.status = 1
            ORDER BY su.name
        `);
        res.json(rows);
    } catch (err) {
        res.status(500).json({ error: err.message });
    } finally {
        await conn.end();
    }
});

router.post('/api/ifood/solicitar-codigo', async (req, res) => {
    ifoodLog('📥 POST /api/ifood/solicitar-codigo — body recebido', req.body);

    const { empresa_id, merchant_id, merchant_nome, ambiente = 'PRODUCAO' } = req.body;
    if (!empresa_id || !merchant_id) {
        const erro = { error: 'empresa_id e merchant_id são obrigatórios' };
        ifoodLog('⚠️  Validação falhou', erro);
        return res.status(400).json(erro);
    }

    ifoodLog('🔑 IFOOD_CLIENT_ID configurado?', {
        clientId: process.env.IFOOD_CLIENT_ID ? `${process.env.IFOOD_CLIENT_ID.slice(0, 6)}...` : 'NÃO DEFINIDO',
    });

    try {
        // clientId como query param + Content-Type form-urlencoded (exigido pela API)
        const resp = await ifoodAxios({
            method: 'post',
            url: `https://merchant-api.ifood.com.br/authentication/v1.0/oauth/userCode`,
            params: { clientId: process.env.IFOOD_CLIENT_ID },
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            data: new URLSearchParams({ clientId: process.env.IFOOD_CLIENT_ID }).toString(),
        });

        const { userCode, verificationUrl, authorizationCodeVerifier, expiresIn } = resp.data;

        const conn = await getConnection();
        try {
            await conn.execute(`
                INSERT INTO ifood_credenciais (empresa_id, merchant_id, merchant_nome, status, ambiente)
                VALUES (?, ?, ?, 'PENDENTE', ?)
                ON DUPLICATE KEY UPDATE
                    merchant_nome = VALUES(merchant_nome),
                    status        = 'PENDENTE',
                    ultimo_erro   = NULL
            `, [empresa_id, merchant_id, merchant_nome || '', ambiente]);

            const [linhas] = await conn.execute(
                `SELECT id FROM ifood_credenciais WHERE empresa_id = ? AND ambiente = ? LIMIT 1`,
                [empresa_id, ambiente]
            );
            const credencialId = linhas[0].id;

            ifoodPendingAuth.set(credencialId, {
                userCode,
                authorizationCodeVerifier,
                expiresAt: Date.now() + (expiresIn || 600) * 1000,
            });

            ifoodLog('✅ Código solicitado com sucesso', { credencialId, userCode, verificationUrl, expiresIn });
            res.json({ credencialId, userCode, verificationUrl, expiresIn });
        } finally {
            await conn.end();
        }
    } catch (err) {
        log(`❌ Erro ao solicitar código iFood: ${err.message}`, 'iFoodAuth');
        res.status(500).json({ error: 'Erro ao solicitar código iFood: ' + (err.response?.data?.message || err.message) });
    }
});

router.post('/api/ifood/verificar-autorizacao', async (req, res) => {
    ifoodLog('📥 POST /api/ifood/verificar-autorizacao — body recebido', {
        credencial_id:      req.body.credencial_id,
        authorization_code: req.body.authorization_code
            ? req.body.authorization_code.slice(0, 8) + '...'
            : 'NÃO INFORMADO',
    });

    const { credencial_id, authorization_code } = req.body;
    const id = Number(credencial_id);

    if (!authorization_code) {
        return res.status(400).json({ error: 'authorization_code é obrigatório.' });
    }

    const pending = ifoodPendingAuth.get(id);

    if (!pending) {
        ifoodLog('⚠️  Sem autorização pendente no Map', { credencial_id, mapKeys: [...ifoodPendingAuth.keys()] });
        return res.status(400).json({ error: 'Sessão expirada ou inválida. Solicite um novo código.' });
    }
    if (Date.now() > pending.expiresAt) {
        ifoodLog('⚠️  Código expirado', { credencial_id, expiresAt: new Date(pending.expiresAt).toISOString() });
        ifoodPendingAuth.delete(id);
        return res.status(400).json({ error: 'Código expirado. Solicite um novo código.' });
    }

    ifoodLog('🔁 Trocando authorizationCode por token', {
        authorizationCode: authorization_code.slice(0, 8) + '...',
        verifier:          pending.authorizationCodeVerifier.slice(0, 12) + '...',
    });

    try {
        const tokenResp = await ifoodAxios({
            method: 'post',
            url: 'https://merchant-api.ifood.com.br/authentication/v1.0/oauth/token',
            data: new URLSearchParams({
                grantType:                 'authorization_code',
                clientId:                  process.env.IFOOD_CLIENT_ID,
                clientSecret:              process.env.IFOOD_CLIENT_SECRET,
                authorizationCode:         authorization_code,
                authorizationCodeVerifier: pending.authorizationCodeVerifier,
            }).toString(),
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        });

        const { accessToken, refreshToken, expiresIn } = tokenResp.data;
        const expiraEm = DateTime.now()
            .plus({ seconds: expiresIn || 21600 })
            .toFormat('yyyy-MM-dd HH:mm:ss');

        const conn = await getConnection();
        try {
            await conn.execute(`
                UPDATE ifood_credenciais
                   SET access_token           = ?,
                       access_token_expira_em = ?,
                       refresh_token          = ?,
                       status                 = 'CONECTADA',
                       ultimo_erro            = NULL,
                       conectada_em           = NOW()
                 WHERE id = ?
            `, [accessToken, expiraEm, refreshToken, id]);
        } finally {
            await conn.end();
        }

        ifoodPendingAuth.delete(id);
        ifoodLog('✅ Loja conectada com sucesso', { credencial_id: id, expiraEm });
        res.json({ status: 'conectada', message: 'Loja conectada com sucesso!' });
    } catch (err) {
        log(`❌ Erro ao verificar autorização iFood: ${err.message}`, 'iFoodAuth');
        // 401/403 = usuário ainda não autorizou ou o código expirou
        if ([401, 403].includes(err.response?.status)) {
            return res.json({ status: 'pending', message: 'Autorização ainda não confirmada no iFood. Certifique-se de ter clicado em "Autorizar" no portal do parceiro e tente novamente.' });
        }
        const detalhe = err.response?.data?.error?.message || err.response?.data?.message || err.message;
        res.status(500).json({ error: detalhe });
    }
});

router.delete('/api/ifood/credencial/:id', async (req, res) => {
    const conn = await getConnection();
    try {
        await conn.execute(
            `UPDATE ifood_credenciais SET status = 'DESCONECTADA', ultimo_erro = 'Desconectado manualmente' WHERE id = ?`,
            [req.params.id]
        );
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    } finally {
        await conn.end();
    }
});

// Salva refresh_token manualmente (fallback quando userCode não está habilitado)
router.post('/api/ifood/salvar-token-manual', async (req, res) => {
    ifoodLog('📥 POST /api/ifood/salvar-token-manual — body recebido', {
        ...req.body,
        refresh_token: req.body.refresh_token ? req.body.refresh_token.slice(0, 12) + '...' : 'VAZIO',
    });

    const { empresa_id, merchant_id, merchant_nome, refresh_token, ambiente = 'PRODUCAO' } = req.body;
    if (!empresa_id || !merchant_id || !refresh_token) {
        return res.status(400).json({ error: 'empresa_id, merchant_id e refresh_token são obrigatórios' });
    }

    const conn = await getConnection();
    try {
        await conn.execute(`
            INSERT INTO ifood_credenciais (empresa_id, merchant_id, merchant_nome, refresh_token, status, ambiente)
            VALUES (?, ?, ?, ?, 'CONECTADA', ?)
            ON DUPLICATE KEY UPDATE
                merchant_nome = VALUES(merchant_nome),
                refresh_token = VALUES(refresh_token),
                status        = 'CONECTADA',
                ultimo_erro   = NULL,
                conectada_em  = NOW()
        `, [empresa_id, merchant_id, merchant_nome || '', refresh_token, ambiente]);

        ifoodLog('✅ Token manual salvo com sucesso', { empresa_id, merchant_id, ambiente });
        res.json({ success: true, message: 'Token salvo com sucesso.' });
    } catch (err) {
        ifoodLog('❌ Erro ao salvar token manual', { error: err.message });
        res.status(500).json({ error: err.message });
    } finally {
        await conn.end();
    }
});

router.get('/api/ifood/pedido/:orderId', async (req, res) => {
    const { orderId } = req.params;
    const conn = await getConnection();
    try {
        // Busca qual credencial tem esse pedido (via ifood_pedidos ou qualquer credencial conectada)
        const [credRows] = await conn.execute(`
            SELECT c.* FROM ifood_credenciais c
            LEFT JOIN ifood_pedidos p ON p.merchant_id = c.merchant_id
            WHERE p.order_id = ? AND c.status = 'CONECTADA'
            LIMIT 1
        `, [orderId]);

        // Fallback: se o pedido não estiver na tabela ainda, usa qualquer credencial conectada
        let cred = credRows[0];
        if (!cred) {
            const [any] = await conn.execute(
                `SELECT * FROM ifood_credenciais WHERE status = 'CONECTADA' LIMIT 1`
            );
            cred = any[0];
        }

        if (!cred) return res.status(404).json({ error: 'Nenhuma credencial iFood conectada.' });

        // Garante access_token válido
        const agora = Date.now();
        const expira = cred.access_token_expira_em ? new Date(cred.access_token_expira_em).getTime() : 0;
        let token = cred.access_token;

        if (!token || expira - 5 * 60 * 1000 <= agora) {
            const params = new URLSearchParams({
                grantType: 'refresh_token',
                clientId: process.env.IFOOD_CLIENT_ID,
                clientSecret: process.env.IFOOD_CLIENT_SECRET,
                refreshToken: cred.refresh_token,
            });
            const tokenResp = await ifoodAxios({
                method: 'POST',
                url: 'https://merchant-api.ifood.com.br/authentication/v1.0/oauth/token',
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                data: params.toString(),
            });
            token = tokenResp.data.accessToken;
        }

        const headers = { Authorization: `Bearer ${token}`, Accept: 'application/json' };
        if (process.env.IFOOD_AMBIENTE === 'TESTE') headers['x-request-homologation'] = 'true';

        const orderResp = await ifoodAxios({
            url: `https://merchant-api.ifood.com.br/order/v1.0/orders/${orderId}`,
            headers,
        });

        res.json(orderResp.data);
    } catch (err) {
        const status = err.response?.status || 500;
        res.status(status).json({ error: err.response?.data || err.message });
    } finally {
        await conn.end();
    }
});

router.post('/run/ifood-sync', async (req, res) => {
    const { ExecuteJobIfoodSync } = require('./workers/workerIfoodSync');
    ExecuteJobIfoodSync()
        .then(() => log('✅ iFood Sync manual finalizado.', 'ExpressServer'))
        .catch(err => log(`❌ Erro iFood Sync manual: ${err.message}`, 'ExpressServer'));
    res.json({ success: true, message: 'iFood Sync iniciado em background. Acompanhe em logs/ifood.log' });
});

router.get('/ifood', (req, res) => {
    res.sendFile(path.join(__dirname, 'views/ifood.html'));
});

// ============================================================

router.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'views/dashboard.html'));
});

app.use('/jobs', router);

app.listen(PORT, () => {
    log(`🟢 Servidor iniciado na porta ${PORT}`, 'ExpressServer');
});
