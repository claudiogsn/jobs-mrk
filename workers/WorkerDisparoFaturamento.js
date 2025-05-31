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
    ,{ nome: 'Edno', telefone: '5571992649337' }
    ,{nome: 'Pedro', telefone: '5571992501052' }
];

function formatCurrency(value) {
    return 'R$ ' + value.toFixed(2)
        .replace('.', ',')
        .replace(/\B(?=(\d{3})+(?!\d))/g, '.');
}

function calcularVariacao(ontem, semanaPassada) {
    // Se o valor da semana passada for zero e o valor de ontem for maior que zero, consideramos 100% de aumento
    if (semanaPassada === 0 && ontem > 0) {
        return `100% 🟢`;  // Caso de aumento absoluto, pois a semana passada foi zero
    }

    // Se a divisão não for válida (por exemplo, quando ambos os valores forem zero), retornamos 0%
    const percentual = ((ontem - semanaPassada) / semanaPassada) * 100;

    if (isNaN(percentual) || !isFinite(percentual)) {
        return '0% 🟠'; // Retorna '0%' se for NaN ou Infinity
    }

    // Definir o símbolo da seta com base no sinal da variação
    const simboloSeta = percentual >= 0 ? '🟢' : '🔴';  // Seta para cima ou para baixo

    return `${percentual.toFixed(2)}% ${simboloSeta}`;  // Adiciona a seta após a porcentagem
}

async function gerarFilaWhatsapp() {
    const groupId = '1';

    const hoje = new Date();
    const ontem = new Date(hoje);
    ontem.setDate(hoje.getDate() - 1);
    const dataRef = ontem.toLocaleDateString('pt-BR');
    const dt_inicio = `${ontem.toISOString().split('T')[0]} 00:00:00`;
    const dt_fim = `${ontem.toISOString().split('T')[0]} 23:59:59`;

    // Calcular data de 7 dias atrás (mesmo dia da semana)
    const seteDiasAtras = new Date(ontem);
    seteDiasAtras.setDate(ontem.getDate() - 7);
    const dt_inicio_semanal = `${seteDiasAtras.toISOString().split('T')[0]} 00:00:00`;
    const dt_fim_semanal = `${seteDiasAtras.toISOString().split('T')[0]} 23:59:59`;

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
        lojas: 0,
        faturamento_bruto_semanal: 0,
        faturamento_liquido_semanal: 0,
        descontos_semanal: 0,
        taxa_servico_semanal: 0,
        ticket_medio_soma_semanal: 0,
        numero_clientes_semanal: 0,  // Adicionado para somar clientes da semana passada
    };

    for (const unidade of unidades) {
        const { custom_code, name: unitName } = unidade;

        // Consulta para ontem
        const resumoOntem = await callPHP('generateResumoFinanceiroPorLoja', {
            lojaid: custom_code,
            dt_inicio,
            dt_fim
        });

        // Consulta para 7 dias atrás
        const resumoSemanaPassada = await callPHP('generateResumoFinanceiroPorLoja', {
            lojaid: custom_code,
            dt_inicio: dt_inicio_semanal,
            dt_fim: dt_fim_semanal
        });

        if (!resumoOntem || !resumoSemanaPassada) {
            log(`⚠️ Sem resumo para ${unitName}`, 'workerFila');
            continue;
        }

        // Calculando variação percentual com o novo cálculo
        const variacaoFaturamentoBruto = calcularVariacao(resumoOntem.faturamento_bruto, resumoSemanaPassada.faturamento_bruto);
        const variacaoFaturamentoLiquido = calcularVariacao(resumoOntem.faturamento_liquido, resumoSemanaPassada.faturamento_liquido);
        const variacaoDescontos = calcularVariacao(resumoOntem.descontos, resumoSemanaPassada.descontos);
        const variacaoTaxaServico = calcularVariacao(resumoOntem.taxa_servico, resumoSemanaPassada.taxa_servico);
        const variacaoTicketMedio = calcularVariacao(resumoOntem.ticket_medio, resumoSemanaPassada.ticket_medio);
        const variacaoNumeroClientes = calcularVariacao(resumoOntem.numero_clientes, resumoSemanaPassada.numero_clientes);  // Variação de clientes


        corpoMensagem +=
            `📍 ${unitName}
💰 Bruto: ${formatCurrency(resumoOntem.faturamento_bruto)} [vs ${formatCurrency(resumoSemanaPassada.faturamento_bruto)}]
💵 Líquido: ${formatCurrency(resumoOntem.faturamento_liquido)} [Vs ${formatCurrency(resumoSemanaPassada.faturamento_liquido)}]
🗒 N Pedidos: ${resumoOntem.numero_pedidos} [Vs ${resumoSemanaPassada.numero_pedidos}]
🎟 Descontos: ${formatCurrency(resumoOntem.descontos)} [Vs ${formatCurrency(resumoSemanaPassada.descontos)}]
🧾 Taxa Serviço: ${formatCurrency(resumoOntem.taxa_servico)} [Vs ${formatCurrency(resumoSemanaPassada.taxa_servico)}]
👥 Clientes: ${resumoOntem.numero_clientes} [Vs ${resumoSemanaPassada.numero_clientes}]
📈 Ticket Médio: ${formatCurrency(resumoOntem.ticket_medio)} [Vs ${formatCurrency(resumoSemanaPassada.ticket_medio)}]

Variação de Faturamento Liq.: ${calcularVariacao(resumoOntem.faturamento_liquido, resumoSemanaPassada.faturamento_liquido)}
Variação de N.pedidos: ${calcularVariacao(resumoOntem.numero_pedidos, resumoSemanaPassada.numero_pedidos)}
━━━━━━━━━━━━━━━━━━━
`;

        total.faturamento_bruto += resumoOntem.faturamento_bruto;
        total.faturamento_liquido += resumoOntem.faturamento_liquido;
        total.descontos += resumoOntem.descontos;
        total.taxa_servico += resumoOntem.taxa_servico;
        total.numero_clientes += resumoOntem.numero_clientes;
        total.ticket_medio_soma += resumoOntem.ticket_medio;
        total.lojas++;

        total.faturamento_bruto_semanal += resumoSemanaPassada.faturamento_bruto;
        total.faturamento_liquido_semanal += resumoSemanaPassada.faturamento_liquido;
        total.descontos_semanal += resumoSemanaPassada.descontos;
        total.taxa_servico_semanal += resumoSemanaPassada.taxa_servico;
        total.ticket_medio_soma_semanal += resumoSemanaPassada.ticket_medio;
        total.numero_clientes_semanal += resumoSemanaPassada.numero_clientes; // Somando o total de clientes da semana passada
    }

    // Cálculo da variação percentual no consolidado geral
    const variacaoFaturamentoBrutoTotal = calcularVariacao(total.faturamento_bruto, total.faturamento_bruto_semanal);
    const variacaoFaturamentoLiquidoTotal = calcularVariacao(total.faturamento_liquido, total.faturamento_liquido_semanal);
    const variacaoDescontosTotal = calcularVariacao(total.descontos, total.descontos_semanal);
    const variacaoTaxaServicoTotal = calcularVariacao(total.taxa_servico, total.taxa_servico_semanal);
    const variacaoTicketMedioTotal = calcularVariacao(total.ticket_medio_soma, total.ticket_medio_soma_semanal);
    const variacaoClientesTotal = calcularVariacao(total.numero_clientes, total.numero_clientes_semanal); // Variacao do número de clientes

    if (total.lojas > 0) {
        corpoMensagem +=
            `📊 *Consolidado Geral*
💰 *Bruto Total:* *${formatCurrency(total.faturamento_bruto)}* [${formatCurrency(total.faturamento_bruto_semanal)}; ${variacaoFaturamentoBrutoTotal}]
💵 *Líquido Total:* *${formatCurrency(total.faturamento_liquido)}* [${formatCurrency(total.faturamento_liquido_semanal)}; ${variacaoFaturamentoLiquidoTotal}]
🎟 *Descontos Total:* *${formatCurrency(total.descontos)}* [${formatCurrency(total.descontos_semanal)}; ${variacaoDescontosTotal}]
🧾 *Taxa Serviço Total:* *${formatCurrency(total.taxa_servico)}* [${formatCurrency(total.taxa_servico_semanal)}; ${variacaoTaxaServicoTotal}]
👥 *Total de Clientes:* *${total.numero_clientes}* [${total.numero_clientes_semanal}; ${variacaoClientesTotal}]
📈 *Média Ticket Médio:* *${formatCurrency(total.ticket_medio_soma / total.lojas)}* [${formatCurrency(total.ticket_medio_soma_semanal / total.lojas)}; ${variacaoTicketMedioTotal}]
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
