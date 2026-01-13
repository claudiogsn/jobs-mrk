require('dotenv').config();
const { callPHP, formatCurrency, calcularVariacao, sendWhatsappPdf, sendWhatsappText,calcularVariacaoReverse, calcularVariacaoSemBola} = require('../utils/utils');
const { log } = require('../utils/logger');
const axios = require('axios');


async function gerarPdfFaturamento(group_id) {
    const result = await callPHP('gerarPdfFaturamento', { group_id , periodo:'mensal' });
    return result.success ? result.url : null;
}

async function gerarPdfCompras(group_id) {
    const result = await callPHP('gerarPdfCompras', { group_id, periodo:'mensal' });
    return result.success ? result.url : null;
}

async function enviarResumoMensal(contato, grupo) {
    const { nome, telefone } = contato;
    const grupoId = grupo.id;
    const grupoNome = grupo.nome;

    const intervalos = await callPHP('getIntervalosMensais', {});
    const { dt_inicio, dt_fim, dt_inicio_anterior, dt_fim_anterior } = intervalos;

    const dataInicioStr = dt_inicio.split(' ')[0].split('-').reverse().join('/');
    const dataFimStr = dt_fim.split(' ')[0].split('-').reverse().join('/');

    const [resumoAtual, resumoAnterior, notasAtual, notasAnterior] = await Promise.all([
        callPHP('generateResumoFinanceiroPorGrupo', { grupoId, dt_inicio, dt_fim }),
        callPHP('generateResumoFinanceiroPorGrupo', { grupoId, dt_inicio: dt_inicio_anterior, dt_fim: dt_fim_anterior }),
        callPHP('generateNotasPorGrupo', { grupoId, dt_inicio, dt_fim }),
        callPHP('generateNotasPorGrupo', { grupoId, dt_inicio: dt_inicio_anterior, dt_fim: dt_fim_anterior })
    ]);

    function somarResumo(lista) {
        return lista.reduce((acc, item) => {
            acc.faturamento_bruto += item.faturamento_bruto || 0;
            acc.descontos += item.descontos || 0;
            acc.taxa_servico += item.taxa_servico || 0;
            acc.faturamento_liquido += item.faturamento_liquido || 0;
            acc.numero_pedidos += item.numero_pedidos || 0;
            acc.numero_clientes += item.numero_clientes || 0;
            acc.pedidos_presencial += item.pedidos_presencial || 0;
            acc.pedidos_delivery += item.pedidos_delivery || 0;
            return acc;
        }, {
            faturamento_bruto: 0,
            descontos: 0,
            taxa_servico: 0,
            faturamento_liquido: 0,
            numero_pedidos: 0,
            numero_clientes: 0,
            pedidos_presencial: 0,
            pedidos_delivery: 0
        });
    }

    function somarNotas(resp) {
        let total = 0;
        for (const loja of resp?.data || []) {
            for (const nota of loja.notas || []) {
                total += parseFloat(nota.valor_total || 0);
            }
        }
        return total;
    }

    const rAtual = somarResumo(resumoAtual.data || []);
    const rAnt = somarResumo(resumoAnterior.data || []);
    const comprasAtual = somarNotas(notasAtual);
    const comprasAnterior = somarNotas(notasAnterior);

    const ticketAtual = rAtual.faturamento_bruto / (rAtual.numero_clientes || 1);
    const ticketAnt = rAnt.faturamento_bruto / (rAnt.numero_clientes || 1);

    const percentualCMV = (rAtual.faturamento_bruto > 0) ? (comprasAtual / rAtual.faturamento_bruto) * 100 : 0;
    const percentualCMVAnterior = (rAnt.faturamento_bruto > 0) ? (comprasAnterior / rAnt.faturamento_bruto) * 100 : 0;

//     📊 Consolidado Faturamento
// 💰 Bruto: ${formatCurrency(rAtual.faturamento_bruto)} [Vs ${formatCurrency(rAnt.faturamento_bruto)}]
// 🎟 Descontos: ${formatCurrency(rAtual.descontos)} [Vs ${formatCurrency(rAnt.descontos)}]
// 🧾 Taxa Serviço: ${formatCurrency(rAtual.taxa_servico)} [Vs ${formatCurrency(rAnt.taxa_servico)}]
// 💵 Líquido: ${formatCurrency(rAtual.faturamento_liquido)} [Vs ${formatCurrency(rAnt.faturamento_liquido)}]
// 🗒 N.Pedidos Presencial: ${rAtual.pedidos_presencial} [Vs ${rAnt.pedidos_presencial}]
// 🛵 N.Pedidos Delivery: ${rAtual.pedidos_delivery} [Vs ${rAnt.pedidos_delivery}]
// 👥 Clientes: ${rAtual.numero_clientes} [Vs ${rAnt.numero_clientes}]
// 📈 Ticket Médio: ${formatCurrency(ticketAtual)} [Vs ${formatCurrency(ticketAnt)}]
//
// 📊 Variações
// • Faturamento Líquido: ${calcularVariacao(rAtual.faturamento_liquido, rAnt.faturamento_liquido)}
// • N. Pedidos Presencial: ${calcularVariacao(rAtual.pedidos_presencial, rAnt.pedidos_presencial)}
// • N. Pedidos Delivery: ${calcularVariacao(rAtual.pedidos_delivery, rAnt.pedidos_delivery)}
// ━━━━━━━━━━━━━━━━━━━
//
// 📍 Consolidado Compras

    const corpoMensagem = `
🌅 Boa tarde, *${nome}*!
Segue resumo mensal do *${grupoNome}*, referente a ${dataInicioStr} a ${dataFimStr}:


💰 Faturamento: ${formatCurrency(rAtual.faturamento_bruto)} [Vs ${formatCurrency(rAnt.faturamento_bruto)}]
🛒 Compras: ${formatCurrency(comprasAtual)} [Vs ${formatCurrency(comprasAnterior)}]
📊 %CMV: ${percentualCMV.toFixed(2)}% [Vs ${percentualCMVAnterior.toFixed(2)}%]

Variação Faturamento: ${calcularVariacaoSemBola(rAtual.faturamento_bruto, rAnt.faturamento_bruto)}
Variação Compras: ${calcularVariacaoSemBola(comprasAtual, comprasAnterior)}
Variação %CMV: ${calcularVariacaoReverse(percentualCMV, percentualCMVAnterior)}
━━━━━━━━━━━━━━━━━━━

O PDF com os detalhes será enviado a seguir.
    `;

    await sendWhatsappText(telefone, corpoMensagem.trim());

    const [urlFat, urlCmp] = await Promise.all([
        gerarPdfFaturamento(grupoId, 'mensal'),
        gerarPdfCompras(grupoId, 'mensal')
    ]);

    if (urlFat) await sendWhatsappPdf(telefone, urlFat);
    if (urlCmp) await sendWhatsappPdf(telefone, urlCmp);

    return true;
}

async function WorkerReportPdfMonthly() {
    const contatosResp = await callPHP('getContatosByDisparo', { id_disparo: 14 });

    if (!contatosResp.success) {
        log('❌ Erro ao buscar contatos', 'WorkerReportPdfWeekly');
        return;
    }

    for (const contato of contatosResp.data) {
        for (const grupo of contato.grupos) {
            await enviarResumoMensal(contato, grupo);
        }
    }
}

module.exports = {
    WorkerReportPdfMonthly,
    enviarResumoMensal
};

if (require.main === module) {
    WorkerReportPdfMonthly();
}
