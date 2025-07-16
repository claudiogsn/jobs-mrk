require('dotenv').config();
const { log } = require('../utils/logger');
const { DateTime } = require('luxon');
const { callPHP, getZig } = require('../utils/apiLogger');

async function processJobCaixaZig(group_id, dataInicio, dataFim) {
    const lojas = await callPHP('getUnitsIntegrationZigBilling', { group_id });

    if (!Array.isArray(lojas) || lojas.length === 0) {
        log(`⚠️ Nenhuma loja encontrada para o grupo ${group_id} entre ${dataInicio} e ${dataFim}`, 'workerBillingZig');
        return;
    }

    log(`🔍 Iniciando processamento de faturamento Zig para o grupo ${group_id} de ${dataInicio} até ${dataFim}`, 'workerBillingZig');

    const dias = gerarIntervaloDatas(dataInicio, dataFim);

    for (const data of dias) {
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
}

function gerarIntervaloDatas(inicio, fim) {
    const datas = [];
    let atual = new Date(inicio);
    const ultima = new Date(fim);

    while (atual <= ultima) {
        const ano = atual.getFullYear();
        const mes = String(atual.getMonth() + 1).padStart(2, '0');
        const dia = String(atual.getDate()).padStart(2, '0');
        datas.push(`${ano}-${mes}-${dia}`);
        atual.setDate(atual.getDate() + 1);
    }

    return datas;
}


async function getZigDadosEstatisticos(lojaId, data, tokenZig) {
    try {
        const [saida, compradores] = await Promise.all([
            getZig('saida-produtos', lojaId, data, data, tokenZig),
            getZig('compradores', lojaId, data, data, tokenZig)
        ]);

        let descontos = 0;
        let gorjeta = 0;

        // Somar descontos e identificar gorjeta
        for (const item of saida) {
            const desconto = parseInt(item.discountValue ?? 0);
            if (!isNaN(desconto)) {
                descontos += desconto;
            }

            const nomeProduto = (item.productName || '').toLowerCase();
            if (nomeProduto.includes('gorjeta')) {
                const gorj = parseInt(item.unitValue ?? 0);
                if (!isNaN(gorj)) {
                    gorjeta += gorj;
                }
            }
        }

        // Filtrar clientes pagos e únicos por documento
        const compradoresPagos = compradores.filter(c => c.isPaid === true);
        const userDocuments = compradoresPagos.map(c => c.userDocument).filter(Boolean);
        const total_clientes_unicos = new Set(userDocuments).size;

        return {
            descontos: parseFloat((descontos / 100).toFixed(2)),
            gorjeta: parseFloat((gorjeta / 100).toFixed(2)),
            total_clientes: total_clientes_unicos,

        };
    } catch (err) {
        log(`❌ Erro ao buscar estatísticas do Zig para loja ${lojaId} em ${data}: ${err.message}`, 'workerBillingZig');
        return {
            descontos: 0,
            gorjeta: 0,
            total_clientes: 0,
        };
    }
}


async function ExecuteJobCaixaZig(dt_inicio, dt_fim) {
    const hoje = DateTime.now().toISODate();
    const ontem = DateTime.now().minus({ days: 1 }).toISODate();

    if (!dt_inicio || !dt_fim) {
        dt_inicio = ontem;
        dt_fim = hoje;
    }

    const grupos = await callPHP('getGroupsToProcess', {});

    if (!Array.isArray(grupos) || grupos.length === 0) {
        log('⚠️ Nenhum grupo encontrado para processar.', 'workerBillingZig');
        return;
    }

    for (const grupo of grupos) {
        const group_id = grupo.id;
        const nomeGrupo = grupo.nome;

        log(`🚀 Processando grupo: ${nomeGrupo} (ID: ${group_id}) de ${dt_inicio} a ${dt_fim}`, 'workerBillingZig');

        await processJobCaixaZig(group_id, dt_inicio, dt_fim);

        log(`🏁 Job finalizado para o grupo ${group_id} às ${DateTime.local().toFormat('HH:mm:ss')}`, 'workerBillingZig');
    }
}


module.exports = { processJobCaixaZig, ExecuteJobCaixaZig };

// Execução direta via terminal
if (require.main === module) {
    ExecuteJobCaixaZig();
}
