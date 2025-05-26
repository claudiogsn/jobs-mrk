require('dotenv').config();
const { SQSClient, SendMessageCommand } = require('@aws-sdk/client-sqs');
const { callPHP } = require('../utils/apiLogger');
const { log } = require('../utils/logger');

const sqs = new SQSClient({
    region: process.env.AWS_REGION,
    credentials: {
        accessKeyId: process.env.AWS_ACCESS_KEY_ID,
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY
    }
});

const DESTINOS = [
    { nome: 'Claudio', telefone: '5583999275543' }
    ,{ nome: 'Paula', telefone: '5571991248941' }
    //,{ nome: 'Edno', telefone: '5571992649337' }
];

function formatCurrency(value) {
    return 'R$ ' + value.toFixed(2)
        .replace('.', ',')
        .replace(/\B(?=(\d{3})+(?!\d))/g, '.');
}

async function gerarFilaWhatsapp() {
    const groupId = '1';

    const hoje = new Date();
    const ontem = new Date(hoje);
    ontem.setDate(hoje.getDate() - 1);
    const dataRef = ontem.toLocaleDateString('pt-BR');
    const dt_inicio = `${ontem.toISOString().split('T')[0]} 00:00:00`;
    const dt_fim = `${ontem.toISOString().split('T')[0]} 23:59:59`;

    const unidades = await callPHP('getUnitsByGroup', { group_id: groupId });
    if (!Array.isArray(unidades)) {
        log('❌ Erro: retorno inesperado de getUnitsByGroup', 'workerFila');
        return;
    }

    let corpoMensagem = `Segue os dados de faturamento do dia ${dataRef} por loja:\n\n━━━━━━━━━━━━━━━━━━━\n`;

    const total = {
        faturamento_bruto: 0,
        faturamento_liquido: 0,
        descontos: 0,
        taxa_servico: 0,
        numero_clientes: 0,
        ticket_medio_soma: 0,
        lojas: 0
    };

    for (const unidade of unidades) {
        const { custom_code, name: unitName } = unidade;

        const resumo = await callPHP('generateResumoFinanceiroPorLoja', {
            lojaid: custom_code,
            dt_inicio,
            dt_fim
        });

        if (!resumo) {
            log(`⚠️ Sem resumo para ${unitName}`, 'workerFila');
            continue;
        }

        corpoMensagem +=
            `📍 ${unitName}
💰 *Bruto:* ${formatCurrency(resumo.faturamento_bruto)}
💵 *Líquido:* ${formatCurrency(resumo.faturamento_liquido)}
🎟 *Descontos:* ${formatCurrency(resumo.descontos)}
🧾 *Taxa Serviço:* ${formatCurrency(resumo.taxa_servico)}
👥 *Clientes:* ${resumo.numero_clientes}
📈 *Ticket Médio:* ${formatCurrency(resumo.ticket_medio)}

━━━━━━━━━━━━━━━━━━━
`;

        total.faturamento_bruto += resumo.faturamento_bruto;
        total.faturamento_liquido += resumo.faturamento_liquido;
        total.descontos += resumo.descontos;
        total.taxa_servico += resumo.taxa_servico;
        total.numero_clientes += resumo.numero_clientes;
        total.ticket_medio_soma += resumo.ticket_medio;
        total.lojas++;
    }

    if (total.lojas > 0) {
        corpoMensagem +=
            `📊 *Consolidado Geral*
💰 *Bruto Total:* ${formatCurrency(total.faturamento_bruto)}
💵 *Líquido Total:* ${formatCurrency(total.faturamento_liquido)}
🎟 *Descontos Total:* ${formatCurrency(total.descontos)}
🧾 *Taxa Serviço Total:* ${formatCurrency(total.taxa_servico)}
👥 *Total de Clientes:* ${total.numero_clientes}
📈 *Média Ticket Médio:* ${formatCurrency(total.ticket_medio_soma / total.lojas)}
`;
    }

    for (const destinatario of DESTINOS) {
        const mensagem =
            `🌅 Bom dia, *${destinatario.nome}!*
${corpoMensagem.trim()}`;

        const payload = {
            telefone: destinatario.telefone,
            mensagem
        };

        try {
            await sqs.send(new SendMessageCommand({
                QueueUrl: process.env.WHATSAPP_QUEUE_URL,
                MessageBody: JSON.stringify(payload)
            }));

            log(`✅ Mensagem enviada para ${destinatario.nome}`, 'workerFila');
        } catch (err) {
            log(`❌ Falha ao enviar para ${destinatario.nome}: ${err.message}`, 'workerFila');
        }
    }
}

module.exports = { gerarFilaWhatsapp };

if (require.main === module) {
    gerarFilaWhatsapp();
}
