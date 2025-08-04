require('dotenv').config();
const { log } = require('../utils/logger');
const { DateTime } = require('luxon');
const { callPHP, getZig } = require('../utils/utils');

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

            const registrosOriginais = await getZig('faturamento', lojaId, data, data, tokenZig);

            // Filtra os registros, separando os que são BÔNUS
            const registros = [];
            let valorBonus = 0;

            for (const r of registrosOriginais) {
                if (r.paymentName?.toUpperCase() === 'BÔNUS') {
                    valorBonus += r.value || 0;
                } else {
                    registros.push(r);
                }
            }

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
                    descontos: (estatisticas.descontos || 0) + parseFloat((valorBonus / 100).toFixed(2)),
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
    let atual = new Date(`${inicio}T00:00:00`);
    const ultima = new Date(`${fim}T00:00:00`);

    while (atual <= ultima) {
        const ano = atual.getFullYear();
        const mes = String(atual.getMonth() + 1).padStart(2, '0');
        const dia = String(atual.getDate()).padStart(2, '0');
        datas.push(`${ano}-${mes}-${dia}`);
        atual.setDate(atual.getDate() + 1);
    }
    console .log(`📅 Intervalo de datas gerado: ${datas.join(', ')}`, 'workerBillingZig');

    return datas;
}

async function getZigDadosEstatisticos(lojaId, data, tokenZig) {
    try {
        const [saida, mesas] = await Promise.all([
            getZig('saida-produtos', lojaId, data, data, tokenZig),
            getZig('tables', lojaId, data, data, tokenZig)
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

        // Somar total de assentos
        const total_clientes = mesas.reduce((soma, mesa) => {
            const assentos = parseInt(mesa.numberOfSeats ?? 0);
            return soma + (isNaN(assentos) ? 0 : assentos);
        }, 0);

        return {
            descontos: parseFloat((descontos / 100).toFixed(2)),
            gorjeta: parseFloat((gorjeta / 100).toFixed(2)),
            total_clientes: total_clientes
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

async function ExecuteJobCaixaZig() {
    const hoje = DateTime.now().toISODate();

    const dt_inicio = DateTime.now().minus({days: 1}).toISODate();
    const dt_fim = hoje;

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

if (require.main === module) {
    ExecuteJobCaixaZig();
}
