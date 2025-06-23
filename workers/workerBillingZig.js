require('dotenv').config();
const { log } = require('../utils/logger');
const { DateTime } = require('luxon');
const { callPHP, getZig } = require('../utils/apiLogger');

// Processa UM único dia
async function processJobCaixaZig(group_id, data) {
    const lojas = await callPHP('getUnitsIntegrationZigBilling', { group_id });

    if (!Array.isArray(lojas) || lojas.length === 0) {
        log(`⚠️ Nenhuma loja encontrada para o grupo ${group_id} no dia ${data}`, 'workerBillingZig');
        return;
    }

    log(`🔍 Iniciando processamento de faturamento Zig para o grupo ${group_id} no dia ${data}`, 'workerBillingZig');

    for (const loja of lojas) {
        const lojaId = loja.lojaId;
        const tokenZig = loja.token_zig;

        if (!lojaId || !tokenZig) {
            log(`⚠️ Dados faltando para loja: ${JSON.stringify(loja)}`, 'workerBillingZig');
            continue;
        }

        const registros = await getZig('faturamento', lojaId, data, data, tokenZig);

        if (registros.length > 0) {
            const payload = {
                method: 'ZigRegisterBilling',
                data: { sales: registros }
            };
            const res = await callPHP(payload.method, payload.data);
            log(`✅ Faturamento loja ${lojaId} em ${data}: ${res?.message || 'sem resposta'}`, 'workerBillingZig');
        } else {
            log(`ℹ️ Sem registros de faturamento para loja ${lojaId} em ${data}`, 'workerBillingZig');
        }

        const estatisticas = await getZigDadosEstatisticos(lojaId, data, tokenZig);

        const staticPayload = {
            method: 'ZigUpdateStatics',
            data: {
                data,
                lojaId,
                descontos: estatisticas.descontos,
                gorjeta: estatisticas.gorjeta,
                total_clientes: estatisticas.total_clientes
            }
        };

        const res2 = await callPHP(staticPayload.method, staticPayload.data);
        log(`📊 Estatísticas loja ${lojaId} em ${data}: ${res2?.message || 'sem resposta'}`, 'workerBillingZig');
    }
}

async function getZigDadosEstatisticos(lojaId, data, tokenZig) {
    try {
        const [saida, compradores] = await Promise.all([
            getZig('saida-produtos', lojaId, data, data, tokenZig),
            getZig('compradores', lojaId, data, data, tokenZig)
        ]);

        let descontos = 0;
        let gorjeta = 0;
        let total_clientes = 0;

        for (const item of saida) {
            const desconto = parseInt(item.discountValue ?? 0);
            if (!isNaN(desconto)) {
                descontos += desconto;
            }

            const nomeProduto = (item.productName || '').toLowerCase();
            if (nomeProduto.includes('gorjeta') && !gorjeta) {
                const gorj = parseInt(item.unitValue ?? 0);
                if (!isNaN(gorj)) {
                    gorjeta = gorj;
                }
            }
        }

        total_clientes = compradores.filter(c => c.isPaid === true).length;

        return {
            descontos: parseFloat((descontos / 100).toFixed(2)),
            gorjeta: parseFloat((gorjeta / 100).toFixed(2)),
            total_clientes
        };
    } catch (err) {
        log(`❌ Erro ao buscar estatísticas do Zig para loja ${lojaId} em ${data}: ${err.message}`, 'workerBillingZig');
        return {
            descontos: 0,
            gorjeta: 0,
            total_clientes: 0
        };
    }
}

// Loop de dias → chama `processJobCaixaZig` para cada dia
async function ExecuteJobCaixaZig(group_id, dt_inicio, dt_fim) {
    const start = DateTime.fromISO(dt_inicio);
    const end = DateTime.fromISO(dt_fim);

    for (let cursor = start; cursor <= end; cursor = cursor.plus({ days: 1 })) {
        const data = cursor.toFormat('yyyy-MM-dd');
        await processJobCaixaZig(group_id, data);
    }

    log(`🏁 Job finalizado para o grupo ${group_id} às ${DateTime.local().toFormat('HH:mm:ss')}`, 'workerBillingZig');
}

module.exports = { processJobCaixaZig, ExecuteJobCaixaZig };

// Execução direta via terminal
if (require.main === module) {
    const group_id = process.env.GROUP_ID;
    const hoje = DateTime.local().startOf('day');
    const ontem = hoje.minus({ days: 1 });

    // const dt_inicio = ontem.toFormat('yyyy-MM-dd');
    // const dt_fim = ontem.toFormat('yyyy-MM-dd');

    const dt_inicio = '2025-02-01'; // Data fixa para testes
    const dt_fim = '2025-06-22'; // Data fixa para testes

    log(`⏱️ Iniciando job de ${dt_inicio} até ${dt_fim} às ${hoje.toFormat('HH:mm:ss')}`, 'workerBillingZig');
    ExecuteJobCaixaZig(group_id, dt_inicio, dt_fim);
}
