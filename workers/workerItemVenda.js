require('dotenv').config();
const { log } = require('../utils/logger');
const { DateTime } = require('luxon');
const axios = require('axios');
const { callPHP, appendApiLog } = require('../utils/apiLogger');

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

module.exports = { processItemVenda };

if (require.main === module) {
    const group_id = process.env.GROUP_ID;
    const dt_inicio = DateTime.now().minus({ days: 1 }).toISODate();
    const dt_fim = dt_inicio;
    processItemVenda({ group_id, dt_inicio, dt_fim });
}
