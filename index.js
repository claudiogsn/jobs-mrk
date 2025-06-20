require('dotenv').config();
require('./server');
const cron = require('node-cron');
const { ExecuteJobCaixa } = require('./workers/workerMovimentoCaixa');
const { ExecuteJobItemVenda } = require('./workers/workerItemVenda');
const {ExecuteJobConsolidation} = require("./workers/workerConsolidateSales");
const {ExecuteJobDocSaida} = require("./workers/workerCreateDocSaida");
const {processQueueWhatsapp} = require('./workers/workerWhatsapp');
const {gerarFilaWhatsapp} = require('./workers/WorkerDisparoFaturamento');
const {gerarFilaWhatsappCMV} = require('./workers/WorkerDisparoEstoque');
const { ExecuteJobFluxoEstoque } = require('./workers/workerFluxoEstoque');
const {SendReportPdfWithResumo} = require("./workers/WorkerSendReportPdfWeekly");



console.log('🕓 Agendador iniciado. Esperando horários programados...');


cron.schedule('*/30 * * * *', () => {
    console.log(`🔁 Executando job Caixa (cron */30) - ${new Date().toLocaleTimeString()}`);
    ExecuteJobCaixa();
}, {
    timezone: 'America/Sao_Paulo'
});

cron.schedule('34 14 * * *', () => {
    console.log(`🔁 Executando job Caixa (cron */30) - ${new Date().toLocaleTimeString()}`);
    ExecuteJobCaixa();
}, {
    timezone: 'America/Sao_Paulo'
});


cron.schedule('00 4 * * *', () => {
    console.log(`🚀 Executando job ItemVenda às ${new Date().toLocaleTimeString()}`);
    ExecuteJobItemVenda();
}, {
    timezone: 'America/Sao_Paulo'
});

cron.schedule('30 4 * * *', () => {
    console.log(`🚀 Executando job Consolidation às ${new Date().toLocaleTimeString()}`);
    ExecuteJobConsolidation();
}, {
    timezone: 'America/Sao_Paulo'
});

cron.schedule('00 5 * * *', () => {
    console.log(`🚀 Executando job Doc Saida às ${new Date().toLocaleTimeString()}`);
    ExecuteJobDocSaida();
}, {
    timezone: 'America/Sao_Paulo'
});

cron.schedule('00 7 * * *', () => {
    console.log(`🚀 Executando disparo para faturamento ${new Date().toLocaleTimeString()}`);
    gerarFilaWhatsapp();
}, {
    timezone: 'America/Sao_Paulo'
});

cron.schedule('00 9 * * *', () => {
    console.log(`🚀 Executando job Fluxo de Estoque às ${new Date().toLocaleTimeString()}`);
    ExecuteJobFluxoEstoque();
}, {
    timezone: 'America/Sao_Paulo'
});

cron.schedule('0 15 * * 1', () => {
    console.log(`🚀 Executando disparo para CMV ${new Date().toLocaleTimeString()}`);
    gerarFilaWhatsappCMV();
}, {
    timezone: 'America/Sao_Paulo'
});

cron.schedule('0 11 * * 1', () => {
    console.log(`🚀 Executando disparo para faturamento ${new Date().toLocaleTimeString()}`);
    SendReportPdfWithResumo();
}, {
    timezone: 'America/Sao_Paulo'
});

processQueueWhatsapp();


