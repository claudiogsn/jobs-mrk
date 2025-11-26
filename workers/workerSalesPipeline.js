// workers/workerSalesPipeline.js
require('dotenv').config();

const { DateTime } = require('luxon');
const { log } = require('../utils/logger');

const { processItemVenda } = require('./workerItemVenda');
const { processConsolidation } = require('./workerConsolidateSales');
const { ExecuteJobDocSaida } = require('./workerCreateDocSaida');

function isValidYMD(s) {
    return typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s);
}

/**
 * Pipeline completo (parâmetros obrigatórios):
 *  - group_id: number
 *  - dt_inicio: 'YYYY-MM-DD'
 *  - dt_fim: 'YYYY-MM-DD'
 */
async function runSalesPipeline({ group_id, dt_inicio, dt_fim }) {
    if (!group_id || !dt_inicio || !dt_fim) {
        throw new Error('Parâmetros obrigatórios: group_id, dt_inicio, dt_fim');
    }
    if (!isValidYMD(dt_inicio) || !isValidYMD(dt_fim)) {
        throw new Error('Formato de data inválido. Use YYYY-MM-DD.');
    }

    const start = DateTime.fromISO(dt_inicio);
    const end   = DateTime.fromISO(dt_fim);

    if (!start.isValid || !end.isValid) {
        throw new Error('Datas inválidas. Use o formato YYYY-MM-DD.');
    }

    const gid = Number(group_id);

    log(
        `🚀 Pipeline grupo ${gid} de ${start.toFormat('yyyy-MM-dd')} até ${end.toFormat('yyyy-MM-dd')}`,
        'workerSalesPipeline'
    );

    // 1) Importar Itens Vendidos (intervalo completo)
    log(`➡️ Etapa 1/3: Importar itens vendidos`, 'workerSalesPipeline');
    console.log('Passei do 01')
    // await processItemVenda({
    //     group_id: gid,
    //     dt_inicio: start.toFormat('yyyy-MM-dd'),
    //     dt_fim: end.toFormat('yyyy-MM-dd'),
    // });

    // 2) Consolidar vendas por grupo (assinatura POSICIONAL)
    log(`➡️ Etapa 2/3: Consolidar vendas`, 'workerSalesPipeline');
    await processConsolidation(
        gid,
        start.toFormat('yyyy-MM-dd'),
        end.toFormat('yyyy-MM-dd')
    );

    // 3) Baixa de estoque por dia (a função já itera internamente)
    log(`➡️ Etapa 3/3: Baixa de estoque`, 'workerSalesPipeline');
    await ExecuteJobDocSaida(
        start.toFormat('yyyy-MM-dd'),
        end.toFormat('yyyy-MM-dd'),
        gid
    );

    log(`✅ Pipeline concluído para grupo ${gid}`, 'workerSalesPipeline');

    return { status: 'ok', group_id: gid, dt_inicio, dt_fim };
}

module.exports = { runSalesPipeline };
