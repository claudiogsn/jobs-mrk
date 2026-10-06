require('dotenv').config();
const { log } = require('../utils/logger');
const { DateTime } = require('luxon');
const { callPHP, getZig } = require('../utils/utils');

function exigirSucesso(resposta, operacao) {
    if (!resposta || resposta.success !== true) {
        throw new Error(`${operacao}: ${resposta?.message || 'a API não confirmou a operação'}`);
    }
}

async function processJobCaixaZig(group_id, dataInicio, dataFim) {
    dataInicio = dataInicio || DateTime.now().setZone('America/Fortaleza').minus({ days: 1 }).toISODate();
    dataFim = dataFim || dataInicio;
    const lojas = await callPHP('getUnitsIntegrationZigBilling', { group_id });
    if (!Array.isArray(lojas)) throw new Error('Não foi possível consultar as unidades Zig.');
    if (lojas.length === 0) return;
    const dias = gerarIntervaloDatas(dataInicio, dataFim);
    const falhas = [];
    for (const data of dias) {
        for (const loja of lojas) {
            const lojaId = loja.lojaId;
            const tokenZig = loja.token_zig;
            const systemUnitId = loja.system_unit_id;
            try {
                if (!lojaId || !tokenZig || !systemUnitId) throw new Error('Unidade Zig sem configuração completa.');
                const registrosOriginais = await getZig('faturamento', lojaId, data, data, tokenZig, { strict: true });
                if (!Array.isArray(registrosOriginais)) throw new Error('Faturamento Zig inválido.');
                const registros = [];
                let valorBonus = 0;
                for (const r of registrosOriginais) {
                    const valor = Number(r.value ?? 0);
                    if (!Number.isFinite(valor)) throw new Error('Valor de pagamento Zig inválido.');
                    if (r.paymentName?.toUpperCase() === 'BÔNUS') valorBonus += valor;
                    else if (valor > 0) {
                        for (const campo of ['paymentId', 'eventId', 'eventDate', 'lojaId', 'redeId']) {
                            if (r[campo] == null || r[campo] === '') throw new Error(`Pagamento Zig sem ${campo}.`);
                        }
                        registros.push({ ...r, system_unit_id: systemUnitId });
                    }
                }
                // Consulta todas as estatísticas antes de substituir dados já importados.
                const estatisticas = registros.length ? await getZigDadosEstatisticos(lojaId, data, tokenZig) : null;
                const resposta = await callPHP('ZigRegisterBilling', {
                    sales: registros, system_unit_id: systemUnitId, lojaId, data
                });
                exigirSucesso(resposta, 'Registrar faturamento Zig');
                if (estatisticas) {
                    const respostaEstatisticas = await callPHP('ZigUpdateStatics', {
                        data, lojaId, system_unit_id: systemUnitId,
                        descontos: estatisticas.descontos + Number((valorBonus / 100).toFixed(2)),
                        gorjeta: estatisticas.gorjeta, total_clientes: estatisticas.total_clientes
                    });
                    exigirSucesso(respostaEstatisticas, 'Atualizar estatísticas Zig');
                }
                log(`Faturamento e estatísticas da unidade ${systemUnitId} em ${data} processados.`, 'workerBillingZig');
            } catch (err) {
                falhas.push(`unidade ${systemUnitId}, ${data}: ${err.message}`);
                log(`Falha no faturamento Zig da unidade ${systemUnitId} em ${data}: ${err.message}`, 'workerBillingZig');
            }
        }
    }
    if (falhas.length) throw new Error(`Falha em ${falhas.length} processamento(s) Zig: ${falhas.join('; ')}`);
}

function gerarIntervaloDatas(inicio, fim) {
    let atual = DateTime.fromISO(inicio, { zone: 'America/Fortaleza' });
    const ultima = DateTime.fromISO(fim, { zone: 'America/Fortaleza' });
    if (!atual.isValid || !ultima.isValid || atual.toISODate() !== inicio || ultima.toISODate() !== fim || atual > ultima) {
        throw new Error('Período Zig inválido ou invertido.');
    }
    const datas = [];
    while (atual <= ultima) {
        datas.push(atual.toISODate());
        atual = atual.plus({ days: 1 });
    }
    return datas;
}

async function getZigDadosEstatisticos(lojaId, data, tokenZig) {
    try {
        const [saida, mesas] = await Promise.all([
            getZig('saida-produtos', lojaId, data, data, tokenZig, { strict: true }),
            getZig('tables', lojaId, data, data, tokenZig, { strict: true })
        ]);

        if (!Array.isArray(saida) || !Array.isArray(mesas)) throw new Error('Estatísticas Zig inválidas.');
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
        throw err;
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
