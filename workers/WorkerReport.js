require('dotenv').config();
const { callPHP } = require('../utils/apiLogger');
const { log } = require('../utils/logger');
const axios = require('axios');

function formatCurrency(value) {
    return 'R$ ' + (value || 0).toFixed(2).replace('.', ',').replace(/\B(?=(\d{3})+(?!\d))/g, '.');
}

function calcularVariacao(atual, anterior) {
    if (anterior === 0 && atual > 0) return `100% 🟢`;
    const percentual = ((atual - anterior) / anterior) * 100;
    if (isNaN(percentual) || !isFinite(percentual)) return '0% 🟠';
    return `${percentual.toFixed(2)}% ${percentual >= 0 ? '🟢' : '🔴'}`;
}

async function sendWhatsappText(telefone, mensagem) {
    try {
        await axios.post(
            `${process.env.ZAPI_BASE_URL}/instances/${process.env.ZAPI_INSTANCE_ID}/token/${process.env.ZAPI_INSTANCE_TOKEN}/send-text`,
            { phone: telefone, message: mensagem },
            { headers: { 'Content-Type': 'application/json', 'Client-Token': process.env.ZAPI_CLIENT_TOKEN } }
        );
        log(`📤 Texto enviado para ${telefone}`, 'WorkerReport');
    } catch (err) {
        log(`❌ Erro ao enviar texto: ${err.message}`, 'WorkerReport');
    }
}

async function sendWhatsappPdf(telefone, url) {
    const fileName = url.split('/').pop();
    try {
        await axios.post(
            `${process.env.ZAPI_BASE_URL}/instances/${process.env.ZAPI_INSTANCE_ID}/token/${process.env.ZAPI_INSTANCE_TOKEN}/send-document/pdf`,
            { phone: telefone, document: url, fileName },
            { headers: { 'Content-Type': 'application/json', 'Client-Token': process.env.ZAPI_CLIENT_TOKEN } }
        );
        log(`📎 PDF ${fileName} enviado para ${telefone}`, 'WorkerReport');
    } catch (err) {
        log(`❌ Erro ao enviar PDF: ${err.message}`, 'WorkerReport');
    }
}

async function gerarPdfFaturamento(group_id) {
    const result = await callPHP('gerarPdfSemanalFaturamento', { group_id });
    return result.success ? result.url : null;
}

async function gerarPdfCompras(group_id) {
    const result = await callPHP('gerarPdfSemanalCompras', { group_id });
    return result.success ? result.url : null;
}

async function enviarResumoParaContato(contato, grupo) {
    const { nome, telefone } = contato;
    const grupoId = grupo.id;
    const grupoNome = grupo.nome;

    const intervalos = await callPHP('getIntervalosSemanais', {});
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
            return acc;
        }, {
            faturamento_bruto: 0,
            descontos: 0,
            taxa_servico: 0,
            faturamento_liquido: 0,
            numero_pedidos: 0,
            numero_clientes: 0
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

    const corpoMensagem = `
🌅 Bom tarde, *${nome}*!
Segue resumo semanal do *${grupoNome}*, referente a ${dataInicioStr} a ${dataFimStr}:

📊 Consolidado Faturamento
💰 Bruto: ${formatCurrency(rAtual.faturamento_bruto)} [Vs ${formatCurrency(rAnt.faturamento_bruto)}]
🎟 Descontos: ${formatCurrency(rAtual.descontos)} [Vs ${formatCurrency(rAnt.descontos)}]
🧾 Taxa Serviço: ${formatCurrency(rAtual.taxa_servico)} [Vs ${formatCurrency(rAnt.taxa_servico)}]
💵 Líquido: ${formatCurrency(rAtual.faturamento_liquido)} [Vs ${formatCurrency(rAnt.faturamento_liquido)}]
🗒 N.Pedidos: ${rAtual.numero_pedidos} [Vs ${rAnt.numero_pedidos}]
👥 Clientes: ${rAtual.numero_clientes} [Vs ${rAnt.numero_clientes}]
📈 Ticket Médio: ${formatCurrency(ticketAtual)} [Vs ${formatCurrency(ticketAnt)}]

📊 Variações
• Faturamento Líquido: ${calcularVariacao(rAtual.faturamento_liquido, rAnt.faturamento_liquido)}
• N. Pedidos: ${calcularVariacao(rAtual.numero_pedidos, rAnt.numero_pedidos)}
━━━━━━━━━━━━━━━━━━━

📍 Consolidado Compras
💰 Faturamento: ${formatCurrency(rAtual.faturamento_bruto)} [Vs ${formatCurrency(rAnt.faturamento_bruto)}]
🛒 Compras: ${formatCurrency(comprasAtual)} [Vs ${formatCurrency(comprasAnterior)}]
📊 %CMV: ${percentualCMV.toFixed(2)}% [Vs ${percentualCMVAnterior.toFixed(2)}%]

Variação Faturamento: ${calcularVariacao(rAtual.faturamento_bruto, rAnt.faturamento_bruto)}
Variação %CMV: ${calcularVariacao(percentualCMV, percentualCMVAnterior)}
Variação Compras: ${calcularVariacao(comprasAtual, comprasAnterior)}
━━━━━━━━━━━━━━━━━━━

O PDF com os detalhes será enviado a seguir.
    `;

    await sendWhatsappText(telefone, corpoMensagem.trim());

    const [urlFat, urlCmp] = await Promise.all([
        gerarPdfFaturamento(grupoId),
        gerarPdfCompras(grupoId)
    ]);

    if (urlFat) await sendWhatsappPdf(telefone, urlFat);
    if (urlCmp) await sendWhatsappPdf(telefone, urlCmp);

    return true;
}

async function WorkerReport() {
    const contatosResp = await callPHP('getContatosByDisparo', { id_disparo: 3 });

    if (!contatosResp.success) {
        log('❌ Erro ao buscar contatos', 'WorkerReport');
        return;
    }

    for (const contato of contatosResp.data) {
        for (const grupo of contato.grupos) {
            await enviarResumoParaContato(contato, grupo);
        }
    }
}

module.exports = {
    WorkerReport,
    gerarPdfFaturamento,
    gerarPdfCompras,
    enviarResumoParaContato
};

if (require.main === module) {
    WorkerReport();
}
