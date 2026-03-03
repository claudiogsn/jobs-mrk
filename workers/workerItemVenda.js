require('dotenv').config();
const { log } = require('../utils/logger');
const { DateTime } = require('luxon');
const { callPHP, loginMenew, callMenew} = require('../utils/utils');
const { ExecuteJobStockZig } = require('./workerStockZig');

// Mapeamento das regras: lojaId (systemUnitId) -> nfNumeroC mínimo
const minNfPorLoja = {
    256250: 123260, // Brutus - Pituba
    263884: 61277,  // Brutus - Alphaville
    263491: 61515,  // Brutus - Apipema
    257838: 133691, // Brutus - Bela Vista
    256251: 260827, // Brutus - SSA Shopping
    267549: 20960,  // Brutus - SSA Delivery
    263929: 68938,  // Brutus - Vilas
    267768: 5126    // Brutus - Vilas Delivery
};

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

        // 🟢 APLICAÇÃO DO FILTRO AQUI ANTES DO MAP
        const itensFiltrados = items.filter(item => {
            const notaMinima = minNfPorLoja[systemUnitId];
            const notaAtual = parseInt(item.__nfNumeroC);

            // Se existe regra para essa loja E a nota atual for menor que a mínima, DESCARTA (retorna false)
            if (notaMinima && !isNaN(notaAtual) && notaAtual < notaMinima) {
                return false;
            }
            return true; // Mantém a venda no array
        });

        if (itensFiltrados.length === 0) {
            log(`⚠️ Nenhum item passou no filtro de nota mínima para loja ${customCode}`, 'workerItemVenda');
            continue;
        }

        // 🟢 Agora fazemos o map no array filtrado
        const salesData = itensFiltrados.map(item => ({
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
        log(`✅ Loja ${customCode} processada com sucesso em ${tempoExec} min. Enviados ${salesData.length} itens (de ${items.length} totais).`, 'workerItemVenda');
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

    await ExecuteJobStockZig();
}

module.exports = { processItemVenda, ExecuteJobItemVenda };

if (require.main === module) {
    ExecuteJobItemVenda();
}
