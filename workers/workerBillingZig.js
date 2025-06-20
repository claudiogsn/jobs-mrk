require('dotenv').config();
const axios = require('axios');
const { DateTime } = require('luxon');
const { callPHP,getZigFaturamento } = require('../utils/apiLogger');

async function ExecuteJobCaixaZig() {
    const hoje = DateTime.local();
    const ontem = hoje.minus({ days: 1 });

    // const dt_inicio = ontem.toFormat('yyyy-MM-dd');
    // const dt_fim = hoje.toFormat('yyyy-MM-dd');

    const dt_inicio = '2025-05-31'; // Data fixa para testes
    const dt_fim = '2025-05-31'; // Data fixa para testes

    const lojas = await callPHP('getUnitsIntegrationZigBilling', { group_id: process.env.GROUP_ID });

    if (!Array.isArray(lojas) || lojas.length === 0) {
        console.log('⚠️ Nenhuma loja encontrada.');
        return;
    }

    for (const loja of lojas) {
        const lojaId = loja.lojaId;
        const tokenZig = loja.token_zig;

        if (!lojaId || !tokenZig) {
            console.log(`⚠️ Dados faltando para loja: ${JSON.stringify(loja)}`);
            continue;
        }

        const registros = await getZigFaturamento(lojaId, dt_inicio, dt_fim, tokenZig);

        if (registros.length === 0) {
            console.log(`ℹ️ Nenhum registro encontrado para loja ${lojaId}.`);
            continue;
        }

        const payload = {
            method: 'ZigRegisterBilling',
            token: process.env.API_TOKEN,
            data: { sales: registros }
        };

        const res = await callPHP(payload.method, payload.data, payload.token);

        console.log(`✅ Loja ${lojaId}: ${res?.message || 'sem resposta'}`);
    }

    console.log(`🏁 Job finalizado às ${DateTime.local().toFormat('HH:mm:ss')}`);
}

module.exports = { ExecuteJobCaixaZig };

if (require.main === module) {
    ExecuteJobCaixaZig();
}
