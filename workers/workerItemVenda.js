require('dotenv').config();
const { log } = require('../utils/logger');
const { DateTime } = require('luxon');
const axios = require('axios');
const { callPHP, appendApiLog } = require('../utils/apiLogger');
const { ExecuteJobStockZig } = require('./workerStockZig');


async function callMenew(methodPayload, token) {
    try {
        const res = await axios.post(process.env.MENEW_URL, methodPayload, {
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${token}`
            }
        });
        appendApiLog(`✅ Menew call (${methodPayload?.requests?.method}): sucesso`);
        appendApiLog(`➡️ REQUEST: ${methodPayload?.requests?.method} - ${JSON.stringify(methodPayload)} - URL: ${process.env.MENEW_URL}`);
        appendApiLog(`✅ RESPONSE (${methodPayload?.requests?.method}): ${JSON.stringify(res.data)} - URL: ${process.env.MENEW_URL}`);
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

async function processItemVenda({ group_id, dt_inicio, dt_fim } = {}) {
    const groupId = parseInt(group_id ?? process.env.GROUP_ID);
    const dtinicio = dt_inicio ?? DateTime.now().minus({ days: 1 }).toISODate();
    const dtfim = dt_fim ?? dtinicio;

    const unidades = await callPHP('getUnitsByGroup', { group_id: groupId });

    if (!Array.isArray(unidades) || unidades.length === 0) {
        log('⚠️ Nenhuma unidade encontrada.', 'workerItemVenda');
        return;
    }

    const authToken = await loginMenew();
    if (!authToken) {
        log('❌ Falha ao autenticar na Menew.', 'workerItemVenda');
        return;
    }

    for (const unidade of unidades) {
        const customCode = unidade.custom_code;
        const systemUnitId = unidade.system_unit_id;

        if (!customCode || !systemUnitId) {
            log(`⚠️ Unidade com dados inválidos: ${JSON.stringify(unidade)}`, 'workerItemVenda');
            continue;
        }

        const inicio = Date.now();
        log(`🔄 Iniciando processamento para loja: ${customCode}`, 'workerItemVenda');

        const itemVendaPayload = {
            token: authToken,
            requests: {
                jsonrpc: '2.0',
                method: 'itemvenda',
                params: {
                    lojas: customCode,
                    dtinicio,
                    dtfim
                },
                id: '1'
            }
        };

        const itemVendaResponse = await callMenew(itemVendaPayload, authToken);
        const items = itemVendaResponse?.result;

        if (!Array.isArray(items) || items.length === 0) {
            log(`⚠️ Nenhum item encontrado para loja ${customCode}`, 'workerItemVenda');
            continue;
        }

        const salesData = items.map(item => ({
            idItemVenda: item.idItemVenda,
            valorBruto: item.valorBruto,
            valorUnitario: item.valorUnitario,
            valorUnitarioLiquido: item.valorUnitarioLiquido,
            valorLiquido: item.valorLiquido,
            modoVenda: item.modoVenda,
            idModoVenda: item.idModoVenda,
            quantidade: item.quantidade,
            dtLancamento: item.dtLancamento,
            unidade: item.unidade,
            lojaId: systemUnitId,
            idMaterial: item.idMaterial,
            codMaterial: item.codMaterial,
            descricao: item.descricao,
            grupo__idGrupo: item.grupo__idGrupo,
            grupo__codigo: item.grupo__codigo,
            grupo__descricao: item.grupo__descricao,
            __nfNumeroC: item.__nfNumeroC,
            custom_code: customCode,
            system_unit_id: systemUnitId
        }));

        await callPHP('persistSales', salesData);

        const final = Date.now();
        await callPHP('registerJobExecution', {
            nome_job: 'item-venda-js',
            system_unit_id: systemUnitId,
            custom_code: customCode,
            inicio: DateTime.fromMillis(inicio).toFormat('yyyy-MM-dd HH:mm:ss'),
            final: DateTime.fromMillis(final).toFormat('yyyy-MM-dd HH:mm:ss')
        });

        const tempoExec = ((final - inicio) / 60000).toFixed(2);
        log(`✅ Loja ${customCode} processada com sucesso em ${tempoExec} min`, 'workerItemVenda');
    }
}


async function ExecuteJobItemVenda() {
    const hoje = DateTime.local();
    const ontem = hoje.minus({ days: 1 });

    const dt_inicio = ontem.toFormat('yyyy-MM-dd');
    const dt_fim = hoje.toFormat('yyyy-MM-dd');
    log(`🚀 Iniciando job ItemVenda de ${dt_inicio} até ${dt_fim} às ${hoje.toFormat('HH:mm:ss')}`, 'workerItemVenda');

    const grupos = await callPHP('getGroupsToProcess', {});

    if (!Array.isArray(grupos) || grupos.length === 0) {
        log('⚠️ Nenhum grupo encontrado para processar.', 'workerItemVenda');
        return;
    }

    for (const grupo of grupos) {
        const group_id = grupo.id;
        const nomeGrupo = grupo.nome;
        log(`🚀 Processando grupo: ${nomeGrupo} (ID: ${group_id})`, 'workerItemVenda');
        await processItemVenda({ group_id, dt_inicio, dt_fim });
    }

    log(`✅ Job ItemVenda finalizado às ${hoje.toFormat('HH:mm:ss')}`, 'workerItemVenda');

    ExecuteJobStockZig();
}

module.exports = { processItemVenda, ExecuteJobItemVenda };

if (require.main === module) {
    ExecuteJobItemVenda();
}
