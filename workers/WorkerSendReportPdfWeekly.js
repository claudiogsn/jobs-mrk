require('dotenv').config();
const { callPHP } = require('../utils/apiLogger');
const { log } = require('../utils/logger');
const axios = require('axios');

const DESTINOS = [
    { nome: 'Claudio', telefone: '5583999275543' }
    ,{ nome: 'Paula', telefone: '5571991248941' }
    ,{ nome: 'Edno', telefone: '5571992649337' }
    ,{ nome: 'Pedro', telefone: '5571992501052' }
];

function formatCurrency(value) {
    return 'R$ ' + value.toFixed(2)
        .replace('.', ',')
        .replace(/\B(?=(\d{3})+(?!\d))/g, '.');
}

function calcularVariacao(atual, anterior) {
    if (anterior === 0 && atual > 0) return `100% 🟢`;
    const percentual = ((atual - anterior) / anterior) * 100;
    if (isNaN(percentual) || !isFinite(percentual)) return '0% 🟠';
    return `${percentual.toFixed(2)}% ${percentual >= 0 ? '🟢' : '🔴'}`;
}

function somarCampos(lista, campo) {
    return lista.reduce((acc, loja) => acc + (parseFloat(loja[campo]) || 0), 0);
}

async function sendWhatsappText(telefone, mensagem) {
    try {
        await axios.post(
            `${process.env.ZAPI_BASE_URL}/instances/${process.env.ZAPI_INSTANCE_ID}/token/${process.env.ZAPI_INSTANCE_TOKEN}/send-text`,
            { phone: telefone, message: mensagem },
            {
                headers: {
                    'Content-Type': 'application/json',
                    'Client-Token': process.env.ZAPI_CLIENT_TOKEN
                }
            }
        );
        log(`📤 Mensagem enviada para ${telefone}`, 'workerPdfResumo');
    } catch (err) {
        log(`❌ Erro ao enviar mensagem para ${telefone}: ${err.message}`, 'workerPdfResumo');
    }
}

async function sendWhatsappPdf(telefone, url) {
    const fileName = url.split('/').pop();
    try {
        await axios.post(
            `${process.env.ZAPI_BASE_URL}/instances/${process.env.ZAPI_INSTANCE_ID}/token/${process.env.ZAPI_INSTANCE_TOKEN}/send-document/pdf`,
            {
                phone: telefone,
                document: url,
                fileName
            },
            {
                headers: {
                    'Content-Type': 'application/json',
                    'Client-Token': process.env.ZAPI_CLIENT_TOKEN
                }
            }
        );
        log(`📎 PDF enviado para ${telefone}`, 'workerPdfResumo');
    } catch (err) {
        log(`❌ Erro ao enviar PDF para ${telefone}: ${err.message}`, 'workerPdfResumo');
    }
}

async function SendReportPdfWithResumo() {
    const groupId = '1';

    const hoje = new Date();
    const fimAtual = new Date(hoje.setDate(hoje.getDate() - hoje.getDay())); // último domingo
    const inicioAtual = new Date(fimAtual);
    inicioAtual.setDate(fimAtual.getDate() - 6);

    const dt_inicio = `${inicioAtual.toISOString().split('T')[0]} 00:00:00`;
    const dt_fim = `${fimAtual.toISOString().split('T')[0]} 23:59:59`;

    const dt_inicio_anterior = new Date(inicioAtual);
    const dt_fim_anterior = new Date(fimAtual);
    dt_inicio_anterior.setDate(dt_inicio_anterior.getDate() - 7);
    dt_fim_anterior.setDate(dt_fim_anterior.getDate() - 7);

    const resumoAtual = await callPHP('generateResumoFinanceiroPorGrupo', {
        grupoId: 1,
        dt_inicio,
        dt_fim
    });

    const resumoAnterior = await callPHP('generateResumoFinanceiroPorGrupo', {
        grupoId: 1,
        dt_inicio: `${dt_inicio_anterior.toISOString().split('T')[0]} 00:00:00`,
        dt_fim: `${dt_fim_anterior.toISOString().split('T')[0]} 23:59:59`
    });

    const resumoAtualData = resumoAtual.data || [];
    const resumoAnteriorData = resumoAnterior.data || [];

    const resumoAtualTotal = {
        faturamento_bruto: somarCampos(resumoAtualData, 'faturamento_bruto'),
        descontos: somarCampos(resumoAtualData, 'descontos'),
        taxa_servico: somarCampos(resumoAtualData, 'taxa_servico'),
        faturamento_liquido: somarCampos(resumoAtualData, 'faturamento_liquido'),
        numero_clientes: somarCampos(resumoAtualData, 'numero_clientes'),
        ticket_medio: somarCampos(resumoAtualData, 'ticket_medio'),
        numero_pedidos: somarCampos(resumoAtualData, 'numero_pedidos'),
    };

    const resumoAnteriorTotal = {
        faturamento_bruto: somarCampos(resumoAnteriorData, 'faturamento_bruto'),
        descontos: somarCampos(resumoAnteriorData, 'descontos'),
        taxa_servico: somarCampos(resumoAnteriorData, 'taxa_servico'),
        faturamento_liquido: somarCampos(resumoAnteriorData, 'faturamento_liquido'),
        numero_clientes: somarCampos(resumoAnteriorData, 'numero_clientes'),
        ticket_medio: somarCampos(resumoAnteriorData, 'ticket_medio'),
        numero_pedidos: somarCampos(resumoAnteriorData, 'numero_pedidos'),
    };

    const variacoes = {
        faturamento_liquido: calcularVariacao(resumoAtualTotal.faturamento_liquido, resumoAnteriorTotal.faturamento_liquido),
        numero_pedidos: calcularVariacao(resumoAtualTotal.numero_pedidos, resumoAnteriorTotal.numero_pedidos)
    };

    const textoResumo = (nome) => `
🌅 Bom dia, *${nome}*!
Segue resumo da semana, referente aos dados de *faturamento (${inicioAtual.toLocaleDateString('pt-BR')} a ${fimAtual.toLocaleDateString('pt-BR')})*:

📊 *Consolidado Geral*
💰 Bruto: ${formatCurrency(resumoAtualTotal.faturamento_bruto)} [Vs ${formatCurrency(resumoAnteriorTotal.faturamento_bruto)}]
🎟 Descontos: ${formatCurrency(resumoAtualTotal.descontos)} [Vs ${formatCurrency(resumoAnteriorTotal.descontos)}]
🧾 Taxa Serviço: ${formatCurrency(resumoAtualTotal.taxa_servico)} [Vs ${formatCurrency(resumoAnteriorTotal.taxa_servico)}]
💵 Líquido: ${formatCurrency(resumoAtualTotal.faturamento_liquido)} [Vs ${formatCurrency(resumoAnteriorTotal.faturamento_liquido)}]
🗒 N.Pedidos: ${resumoAtualTotal.numero_pedidos} [Vs ${resumoAnteriorTotal.numero_pedidos}]
👥 Clientes: ${resumoAtualTotal.numero_clientes} [Vs ${resumoAnteriorTotal.numero_clientes}]
📈 Ticket Médio: ${formatCurrency(resumoAtualTotal.ticket_medio)} [Vs ${formatCurrency(resumoAnteriorTotal.ticket_medio)}]

Variação de Faturamento Liq.: ${variacoes.faturamento_liquido}
Variação de N.Pedidos: ${variacoes.numero_pedidos}
━━━━━━━━━━━━━━━━━━━

Para mais detalhes ou uma análise segmentada por loja, por gentileza, verifique o arquivo que será enviado na sequência.
`;

    const result = await callPHP('gerarPdfSemanal', { group_id: 1 });

    if (!result || !result.success || !result.url) {
        log('❌ Erro ao gerar PDF semanal', 'workerPdfResumo');
        return;
    }

    const pdfUrl = result.url;

    for (const { nome, telefone } of DESTINOS) {
        await sendWhatsappText(telefone, textoResumo(nome).trim());
        await sendWhatsappPdf(telefone, pdfUrl);
    }
}

module.exports = { SendReportPdfWithResumo };

if (require.main === module) {
    SendReportPdfWithResumo();
}
