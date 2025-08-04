require('dotenv').config();
const { SQSClient, SendMessageCommand } = require('@aws-sdk/client-sqs');
const { callPHP, formatCurrency, calcularVariacao} = require('../utils/utils');
const { log } = require('../utils/logger');

const sqs = new SQSClient({
    region: process.env.AWS_REGION,
    credentials: {
        accessKeyId: process.env.AWS_ACCESS_KEY_ID,
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY
    }
});

async function enviarResumoDiario(contato, grupo) {
    const { nome, telefone } = contato;
    const groupId = grupo.id;
    const grupoNome = grupo.nome;

    const intervalos = await callPHP('getIntervalosDiarios', {});
    const { dt_inicio, dt_fim, dt_inicio_anterior, dt_fim_anterior } = intervalos;
    const dataRef = dt_inicio.split(' ')[0].split('-').reverse().join('/');

    // Pega as lojas do grupo
    const unidades = await callPHP('getUnitsByGroup', { group_id: groupId });
    if (!Array.isArray(unidades)) {
        log(`❌ Erro: retorno inesperado de getUnitsByGroup para grupo ${grupoNome}`, 'enviarResumoDiario');
        return;
    }

    let corpoMensagem = `Segue os dados de faturamento do dia *${dataRef}* por loja do grupo *${grupoNome}*:\n\n━━━━━━━━━━━━━━━━━━━\n`;

    const total = {
        faturamento_bruto: 0,
        faturamento_liquido: 0,
        descontos: 0,
        taxa_servico: 0,
        numero_clientes: 0,
        ticket_medio_soma: 0,
        lojas: 0,
        faturamento_bruto_semanal: 0,
        faturamento_liquido_semanal: 0,
        descontos_semanal: 0,
        taxa_servico_semanal: 0,
        ticket_medio_soma_semanal: 0,
        numero_clientes_semanal: 0,
        numero_pedidos: 0,
        numero_pedidos_semanal: 0
    };

    for (const unidade of unidades) {
        const { custom_code, name: unitName } = unidade;

        // Consulta para ontem (intervalo atual)
        const resumoOntem = await callPHP('generateResumoFinanceiroPorLoja', {
            lojaid: custom_code,
            dt_inicio,
            dt_fim
        });

        const resumoSemanaPassada = await callPHP('generateResumoFinanceiroPorLoja', {
            lojaid: custom_code,
            dt_inicio: dt_inicio_anterior,
            dt_fim: dt_fim_anterior
        });

        if (!resumoOntem || !resumoSemanaPassada) {
            log(`⚠️ Sem resumo para ${unitName}`, 'enviarResumoDiario');
            continue;
        }

        if (
            resumoOntem.faturamento_bruto === 0 &&
            resumoOntem.faturamento_liquido === 0 &&
            resumoOntem.descontos === 0 &&
            resumoOntem.taxa_servico === 0 &&
            resumoOntem.numero_clientes === 0 &&
            resumoOntem.numero_pedidos === 0
        ) {
            log(`⚠️ Loja ${unitName} sem faturamento no período. Ignorada.`, 'enviarResumoDiario');
            continue;
        }

        corpoMensagem +=
            `📍 *${unitName}*
💰 Bruto: *${formatCurrency(resumoOntem.faturamento_bruto)}* [Vs ${formatCurrency(resumoSemanaPassada.faturamento_bruto)}]
💵 Líquido: *${formatCurrency(resumoOntem.faturamento_liquido)}* [Vs ${formatCurrency(resumoSemanaPassada.faturamento_liquido)}]
🗒 N.Pedidos Presencial: *${resumoOntem.pedidos_presencial || 0}* [Vs ${resumoSemanaPassada.pedidos_presencial}]
🛵 N.Pedidos Delivery: *${resumoOntem.pedidos_delivery || 0}* [Vs ${resumoSemanaPassada.pedidos_delivery}]
🎟 Descontos: *${formatCurrency(resumoOntem.descontos)}* [Vs ${formatCurrency(resumoSemanaPassada.descontos)}]
🧾 Taxa Serviço: *${formatCurrency(resumoOntem.taxa_servico)}* [Vs ${formatCurrency(resumoSemanaPassada.taxa_servico)}]
👥 Clientes: *${resumoOntem.numero_clientes}* [Vs ${resumoSemanaPassada.numero_clientes}]
📈 Ticket Médio: *${formatCurrency(resumoOntem.ticket_medio)}* [Vs ${formatCurrency(resumoSemanaPassada.ticket_medio)}]

Variação de Faturamento Liq.: ${calcularVariacao(resumoOntem.faturamento_liquido, resumoSemanaPassada.faturamento_liquido)}
Variação de N.Pedidos Presencial: ${calcularVariacao(resumoOntem.pedidos_presencial, resumoSemanaPassada.pedidos_presencial)}
Variação de N.Pedidos Delivery: ${calcularVariacao(resumoOntem.pedidos_delivery, resumoSemanaPassada.pedidos_delivery)}

━━━━━━━━━━━━━━━━━━━
`;

        total.faturamento_bruto += resumoOntem.faturamento_bruto;
        total.faturamento_liquido += resumoOntem.faturamento_liquido;
        total.descontos += resumoOntem.descontos;
        total.taxa_servico += resumoOntem.taxa_servico;
        total.numero_clientes += resumoOntem.numero_clientes;
        total.ticket_medio_soma += resumoOntem.ticket_medio;
        total.numero_pedidos += resumoOntem.numero_pedidos;7
        total.pedidos_presencial = (total.pedidos_presencial || 0) + (resumoOntem.pedidos_presencial || 0);
        total.pedidos_delivery = (total.pedidos_delivery || 0) + (resumoOntem.pedidos_delivery || 0);


        total.lojas++;


        total.faturamento_bruto_semanal += resumoSemanaPassada.faturamento_bruto;
        total.faturamento_liquido_semanal += resumoSemanaPassada.faturamento_liquido;
        total.descontos_semanal += resumoSemanaPassada.descontos;
        total.taxa_servico_semanal += resumoSemanaPassada.taxa_servico;
        total.ticket_medio_soma_semanal += resumoSemanaPassada.ticket_medio;
        total.numero_clientes_semanal += resumoSemanaPassada.numero_clientes;
        total.numero_pedidos_semanal += resumoSemanaPassada.numero_pedidos;
        total.pedidos_presencial_semanal = (total.pedidos_presencial_semanal || 0) + (resumoSemanaPassada.pedidos_presencial || 0);
        total.pedidos_delivery_semanal = (total.pedidos_delivery_semanal || 0) + (resumoSemanaPassada.pedidos_delivery || 0);
    }

    if (total.lojas > 1) {
        corpoMensagem +=
            `📊 *Consolidado Geral*
💰 *Bruto:* *${formatCurrency(total.faturamento_bruto)}* [Vs ${formatCurrency(total.faturamento_bruto_semanal)}]
💵 *Líquido:* *${formatCurrency(total.faturamento_liquido)}* [Vs ${formatCurrency(total.faturamento_liquido_semanal)}]
🗒 *N.Pedidos Presencial:* *${total.pedidos_presencial || 0}* [Vs ${total.pedidos_presencial_semanal}]
🛵 *N.Pedidos Delivery:* *${total.pedidos_delivery || 0}* [Vs ${total.pedidos_delivery_semanal}]
🎟 *Descontos:* *${formatCurrency(total.descontos)}* [Vs ${formatCurrency(total.descontos_semanal)}]
🧾 *Taxa Serviço:* *${formatCurrency(total.taxa_servico)}* [Vs ${formatCurrency(total.taxa_servico_semanal)}]
👥 *Clientes:* *${total.numero_clientes}* [Vs ${total.numero_clientes_semanal}]
📈 *Ticket Médio:* *${formatCurrency(total.ticket_medio_soma / total.lojas)}* [Vs ${formatCurrency(total.ticket_medio_soma_semanal / total.lojas)}]

*Variação de Faturamento Liq.:* ${calcularVariacao(total.faturamento_liquido, total.faturamento_liquido_semanal)}
*Variação de N.Pedidos Presencial:* ${calcularVariacao(total.pedidos_presencial, total.pedidos_presencial_semanal)}
*Variação de N.Pedidos Delivery:* ${calcularVariacao(total.pedidos_delivery, total.pedidos_delivery_semanal)}
`;
    }

    if (total.lojas === 0) {
        log(`🚫 Nenhuma loja com faturamento para ${nome} (${grupoNome}). Mensagem não enviada.`, 'enviarResumoDiario');
        return;
    }

    const mensagem = `🌅 Bom dia, *${nome}!*
${corpoMensagem.trim()}`;

    const payload = {
        telefone,
        mensagem
    };

    try {
        await sqs.send(new SendMessageCommand({
            QueueUrl: process.env.WHATSAPP_QUEUE_URL,
            MessageBody: JSON.stringify(payload)
        }));

        log(`✅ Mensagem enviada para ${nome} (${telefone})`, 'enviarResumoDiario');
    } catch (err) {
        log(`❌ Falha ao enviar para ${nome}: ${err.message}`, 'enviarResumoDiario');
    }
}

async function WorkerResumoDiario() {
    const contatosResp = await callPHP('getContatosByDisparo', { id_disparo: 1 });
    if (!contatosResp.success) {
        log('❌ Erro ao buscar contatos', 'WorkerFilaWhatsapp');
        return;
    }

    for (const contato of contatosResp.data) {
        for (const grupo of contato.grupos) {
            await enviarResumoDiario(contato, grupo);
        }
    }
}

module.exports = {
    enviarResumoDiario,
    WorkerResumoDiario
};

if (require.main === module) {
    WorkerResumoDiario();
}
