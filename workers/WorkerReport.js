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
    const hoje = new Date();
    const fimAtual = new Date(hoje.setDate(hoje.getDate() - hoje.getDay() + 6));
    const inicioAtual = new Date(fimAtual); inicioAtual.setDate(fimAtual.getDate() - 6);

    const dt_inicio = `${inicioAtual.toISOString().split('T')[0]} 00:00:00`;
    const dt_fim = `${fimAtual.toISOString().split('T')[0]} 23:59:59`;

    const inicioAnt = new Date(inicioAtual); inicioAnt.setDate(inicioAnt.getDate() - 7);
    const fimAnt = new Date(fimAtual); fimAnt.setDate(fimAnt.getDate() - 7);
    const dt_inicio_anterior = `${inicioAnt.toISOString().split('T')[0]} 00:00:00`;
    const dt_fim_anterior = `${fimAnt.toISOString().split('T')[0]} 23:59:59`;

    const grupoId = grupo.id;
    const grupoNome = grupo.nome;
    const { nome, telefone } = contato;

    const [resumoAtual, resumoAnterior] = await Promise.all([
        callPHP('generateResumoFinanceiroPorGrupo', { grupoId, dt_inicio, dt_fim }),
        callPHP('generateResumoFinanceiroPorGrupo', { grupoId, dt_inicio: dt_inicio_anterior, dt_fim: dt_fim_anterior })
    ]);

    const [cmvAtual, cmvAnterior] = await Promise.all([
        callPHP('generateResumoEstoquePorGrupoNAuth', { grupoId, dt_inicio, dt_fim }),
        callPHP('generateResumoEstoquePorGrupoNAuth', { grupoId, dt_inicio: dt_inicio_anterior, dt_fim: dt_fim_anterior })
    ]);

    const rAtual = resumoAtual.data?.[0] || {};
    const rAnt = resumoAnterior.data?.[0] || {};
    const cAtual = cmvAtual.data?.[0] || {};
    const cAnt = cmvAnterior.data?.[0] || {};

    const ticketAtual = rAtual.faturamento_bruto / (rAtual.numero_clientes || 1);
    const ticketAnt = rAnt.faturamento_bruto / (rAnt.numero_clientes || 1);

    const corpoMensagem = `
🌅 Bom tarde, ${nome}!
Segue resumo semanal do ${grupoNome}, referente a ${inicioAtual.toLocaleDateString('pt-BR')} a ${fimAtual.toLocaleDateString('pt-BR')}:

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
💰 Faturamento: ${formatCurrency(cAtual.faturamento_bruto)} [Vs ${formatCurrency(cAnt.faturamento_bruto)}]
🛒 Compras: ${formatCurrency(cAtual.total_compras)} [Vs ${formatCurrency(cAnt.total_compras)}]
📊 %CMV: ${cAtual.percentual_cmv?.toFixed(2) || '0.00'}% [Vs ${cAnt.percentual_cmv?.toFixed(2) || '0.00'}%]
 
Variação Faturamento: ${calcularVariacao(cAtual.faturamento_bruto, cAnt.faturamento_bruto)}
Variação %CMV: ${calcularVariacao(cAtual.percentual_cmv, cAnt.percentual_cmv)}
Variação Compras: ${calcularVariacao(cAtual.total_compras, cAnt.total_compras)}
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
