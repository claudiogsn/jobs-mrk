require('dotenv').config();
const { SQSClient, SendMessageCommand } = require('@aws-sdk/client-sqs');
const { callPHP } = require('../utils/utils');
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

function calcularVariacao(atual, anterior) {
    if (anterior === 0 && atual > 0) return `100% 🟢`;
    const percentual = ((atual - anterior) / anterior) * 100;
    if (isNaN(percentual) || !isFinite(percentual)) return '0% 🟠';
    return `${percentual.toFixed(2)}% ${percentual >= 0 ? '🟢' : '🔴'}`;
}

function formatCurrency(value) {
    return 'R$ ' + value.toFixed(2).replace('.', ',').replace(/\B(?=(\d{3})+(?!\d))/g, '.');
}

async function gerarFilaWhatsappCMV() {
    const hoje = new Date();
    const ultimaSegunda = new Date(hoje);
    ultimaSegunda.setDate(ultimaSegunda.getDate() - ((hoje.getDay() + 6) % 7 + 7));
    const ultimoDomingo = new Date(ultimaSegunda);
    ultimoDomingo.setDate(ultimaSegunda.getDate() + 6);

    const segundaAnterior = new Date(ultimaSegunda);
    segundaAnterior.setDate(segundaAnterior.getDate() - 7);
    const domingoAnterior = new Date(ultimoDomingo);
    domingoAnterior.setDate(domingoAnterior.getDate() - 7);

    const dt_inicio = `${ultimaSegunda.toISOString().split('T')[0]} 00:00:00`;
    const dt_fim = `${ultimoDomingo.toISOString().split('T')[0]} 23:59:59`;
    const dt_inicio_anterior = `${segundaAnterior.toISOString().split('T')[0]} 00:00:00`;
    const dt_fim_anterior = `${domingoAnterior.toISOString().split('T')[0]} 23:59:59`;

    const semanaRef = `${ultimaSegunda.toLocaleDateString('pt-BR')} a ${ultimoDomingo.toLocaleDateString('pt-BR')}`;
    let corpoMensagem = `Segue resumo da semana, referente aos dados de *estoque - (${semanaRef})*\n━━━━━━━━━━━━━━━━━━━\n`;

    const dadosAtuais = await callPHP('generateResumoEstoquePorGrupoNAuth', {
        dt_inicio,
        dt_fim,
        grupoId: '1'
    });

    const dadosAnteriores = await callPHP('generateResumoEstoquePorGrupoNAuth', {
        dt_inicio: dt_inicio_anterior,
        dt_fim: dt_fim_anterior,
        grupoId: '1'
    });

    if (!Array.isArray(dadosAtuais.data) || !Array.isArray(dadosAnteriores.data)) {
        log('❌ Erro ao obter dados CMV', 'workerCMV');
        return;
    }

    const mapAnteriores = {};
    for (const loja of dadosAnteriores.data) {
        mapAnteriores[loja.lojaId] = loja;
    }

    let soma = {
        atual: {
            faturamento: 0,
            cmv: 0,
            compras: 0,
            saidas: 0
        },
        anterior: {
            faturamento: 0,
            cmv: 0,
            compras: 0,
            saidas: 0
        }
    };

    for (const lojaAtual of dadosAtuais.data) {
        const anterior = mapAnteriores[lojaAtual.lojaId] || {};

        corpoMensagem += `📍 *${lojaAtual.nomeLoja}*\n`;
        corpoMensagem += `💰 Faturamento: *${formatCurrency(lojaAtual.faturamento_bruto)}* [Vs ${formatCurrency(anterior.faturamento_bruto || 0)}]\n`;
        corpoMensagem += `🛒 Compras: *${formatCurrency(lojaAtual.total_compras)}* [Vs ${formatCurrency(anterior.total_compras || 0)}]\n`;
        corpoMensagem += `📊 %CMV: *${lojaAtual.percentual_cmv.toFixed(2)}%* [Vs ${(anterior.percentual_cmv || 0).toFixed(2)}%]\n`;
        corpoMensagem += ` \n`;
        corpoMensagem += `Variação Faturamento: ${calcularVariacao(lojaAtual.faturamento_bruto, anterior.faturamento_bruto || 0)}\n`;
        corpoMensagem += `Variação %CMV: ${calcularVariacao(lojaAtual.percentual_cmv, anterior.percentual_cmv || 0)}\n`;
        corpoMensagem += `Variação Compras: ${calcularVariacao(lojaAtual.total_compras, anterior.total_compras || 0)}\n`;
        corpoMensagem += `━━━━━━━━━━━━━━━━━━━\n`;

        soma.atual.faturamento += lojaAtual.faturamento_bruto || 0;
        soma.atual.cmv += lojaAtual.cmv || 0;
        soma.atual.compras += lojaAtual.total_compras || 0;
        soma.atual.saidas += lojaAtual.total_saidas || 0;

        soma.anterior.faturamento += anterior.faturamento_bruto || 0;
        soma.anterior.cmv += anterior.cmv || 0;
        soma.anterior.compras += anterior.total_compras || 0;
        soma.anterior.saidas += anterior.total_saidas || 0;
    }

    const percentualCmvAtual = soma.atual.faturamento > 0 ? (soma.atual.cmv / soma.atual.faturamento) * 100 : 0;
    const percentualCmvAnterior = soma.anterior.faturamento > 0 ? (soma.anterior.cmv / soma.anterior.faturamento) * 100 : 0;

    corpoMensagem += `📊 *Consolidado Geral*\n`;
    corpoMensagem += `💰 Faturamento: *${formatCurrency(soma.atual.faturamento)}* [Vs ${formatCurrency(soma.anterior.faturamento)}]\n`;
    corpoMensagem += `📊 %CMV: *${percentualCmvAtual.toFixed(2)}%* [Vs ${percentualCmvAnterior.toFixed(2)}%]\n`;
    corpoMensagem += `🛒 Compras: *${formatCurrency(soma.atual.compras)}* [Vs ${formatCurrency(soma.anterior.compras)}]\n`;
    corpoMensagem += `\n`;
    corpoMensagem += `Variação Faturamento: ${calcularVariacao(soma.atual.faturamento, soma.anterior.faturamento)}\n`;
    corpoMensagem += `Variação %CMV: ${calcularVariacao(percentualCmvAtual, percentualCmvAnterior)}\n`;
    corpoMensagem += `Variação Compras: ${calcularVariacao(soma.atual.compras, soma.anterior.compras)}\n`;

    for (const destinatario of DESTINOS) {
        const mensagem = `Boa Tarde, *${destinatario.nome}*!\n\n${corpoMensagem.trim()}`;

        const payload = {
            telefone: destinatario.telefone,
            mensagem
        };

        try {
            await sqs.send(new SendMessageCommand({
                QueueUrl: process.env.WHATSAPP_QUEUE_URL,
                MessageBody: JSON.stringify(payload)
            }));

            log(`✅ Mensagem CMV enviada para ${destinatario.nome}`, 'workerCMV');
        } catch (err) {
            log(`❌ Falha ao enviar CMV para ${destinatario.nome}: ${err.message}`, 'workerCMV');
        }
    }
}

module.exports = { gerarFilaWhatsappCMV };

if (require.main === module) {
    gerarFilaWhatsappCMV();
}
