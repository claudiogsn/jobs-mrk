require('dotenv').config();
const { callPHP } = require('../utils/apiLogger');
const { log } = require('../utils/logger');
const axios = require('axios');

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
    const hoje = new Date();
    const fimAtual = new Date(hoje.setDate(hoje.getDate() - hoje.getDay()));
    const inicioAtual = new Date(fimAtual);
    inicioAtual.setDate(fimAtual.getDate() - 6);

    const dt_inicio = `${inicioAtual.toISOString().split('T')[0]} 00:00:00`;
    const dt_fim = `${fimAtual.toISOString().split('T')[0]} 23:59:59`;

    const dt_inicio_anterior = new Date(inicioAtual);
    const dt_fim_anterior = new Date(fimAtual);
    dt_inicio_anterior.setDate(dt_inicio_anterior.getDate() - 7);
    dt_fim_anterior.setDate(dt_fim_anterior.getDate() - 7);

    // Busca dinâmica dos contatos
    const contatosResp = await callPHP('getContatosByDisparo', {
        id_disparo: 3
    });

    if (!contatosResp || !contatosResp.success || !contatosResp.data) {
        log('❌ Erro ao buscar contatos', 'workerPdfResumo');
        return;
    }

    for (const contato of contatosResp.data) {
        const { nome, telefone, grupos } = contato;

        for (const grupo of grupos) {
            const grupoId = grupo.id;
            const grupoNome = grupo.nome;

            const [resumoAtual, resumoAnterior] = await Promise.all([
                callPHP('generateResumoFinanceiroPorGrupo', {
                    grupoId,
                    dt_inicio,
                    dt_fim
                }),
                callPHP('generateResumoFinanceiroPorGrupo', {
                    grupoId,
                    dt_inicio: `${dt_inicio_anterior.toISOString().split('T')[0]} 00:00:00`,
                    dt_fim: `${dt_fim_anterior.toISOString().split('T')[0]} 23:59:59`
                })
            ]);

            const resumoAtualData = resumoAtual.data || [];
            const resumoAnteriorData = resumoAnterior.data || [];

            const resumoAtualTotal = {
                faturamento_bruto: somarCampos(resumoAtualData, 'faturamento_bruto'),
                descontos: somarCampos(resumoAtualData, 'descontos'),
                taxa_servico: somarCampos(resumoAtualData, 'taxa_servico'),
                faturamento_liquido: somarCampos(resumoAtualData, 'faturamento_liquido'),
                numero_clientes: somarCampos(resumoAtualData, 'numero_clientes'),
                numero_pedidos: somarCampos(resumoAtualData, 'numero_pedidos'),
            };

            const resumoAnteriorTotal = {
                faturamento_bruto: somarCampos(resumoAnteriorData, 'faturamento_bruto'),
                descontos: somarCampos(resumoAnteriorData, 'descontos'),
                taxa_servico: somarCampos(resumoAnteriorData, 'taxa_servico'),
                faturamento_liquido: somarCampos(resumoAnteriorData, 'faturamento_liquido'),
                numero_clientes: somarCampos(resumoAnteriorData, 'numero_clientes'),
                numero_pedidos: somarCampos(resumoAnteriorData, 'numero_pedidos'),
            };

            const variacoes = {
                faturamento_liquido: calcularVariacao(resumoAtualTotal.faturamento_liquido, resumoAnteriorTotal.faturamento_liquido),
                numero_pedidos: calcularVariacao(resumoAtualTotal.numero_pedidos, resumoAnteriorTotal.numero_pedidos)
            };

            const textoResumo = `
🌅 Bom dia, *${nome}*!
Segue resumo semanal do *${grupoNome}*, referente a *${inicioAtual.toLocaleDateString('pt-BR')} a ${fimAtual.toLocaleDateString('pt-BR')}*:

📊 *Consolidado Geral*
💰 Bruto: ${formatCurrency(resumoAtualTotal.faturamento_bruto)} [Vs ${formatCurrency(resumoAnteriorTotal.faturamento_bruto)}]
🎟 Descontos: ${formatCurrency(resumoAtualTotal.descontos)} [Vs ${formatCurrency(resumoAnteriorTotal.descontos)}]
🧾 Taxa Serviço: ${formatCurrency(resumoAtualTotal.taxa_servico)} [Vs ${formatCurrency(resumoAnteriorTotal.taxa_servico)}]
💵 Líquido: ${formatCurrency(resumoAtualTotal.faturamento_liquido)} [Vs ${formatCurrency(resumoAnteriorTotal.faturamento_liquido)}]
🗒 N.Pedidos: ${resumoAtualTotal.numero_pedidos} [Vs ${resumoAnteriorTotal.numero_pedidos}]
👥 Clientes: ${resumoAtualTotal.numero_clientes} [Vs ${resumoAnteriorTotal.numero_clientes}]
📈 Ticket Médio: ${formatCurrency(resumoAtualTotal.faturamento_bruto / resumoAtualTotal.numero_clientes)} [Vs ${formatCurrency(resumoAnteriorTotal.faturamento_bruto / resumoAnteriorTotal.numero_clientes)}]

📊 Variações
• Faturamento Líquido: ${variacoes.faturamento_liquido}
• N. Pedidos: ${variacoes.numero_pedidos}
━━━━━━━━━━━━━━━━━━━

O PDF com os detalhes será enviado a seguir.`;

            const result = await callPHP('gerarPdfSemanal', { group_id: grupoId });

            if (!result || !result.success || !result.url) {
                log(`❌ Erro ao gerar PDF para grupo ${grupoNome}`, 'workerPdfResumo');
                continue;
            }

            await sendWhatsappText(telefone, textoResumo.trim());
            await sendWhatsappPdf(telefone, result.url);
        }
    }
}

module.exports = { SendReportPdfWithResumo };

if (require.main === module) {
    SendReportPdfWithResumo();
}
