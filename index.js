require('dotenv').config();
require('./server');
const { log } = require('./utils/logger');
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


log('🕓 Iniciando agendador de tarefas...', 'CronJob');

cron.schedule('*/25 * * * *', () => {
    log(`🔁 Executando job Caixa (cron */25 - ${new Date().toLocaleTimeString()}`, 'CronJob');
    ExecuteJobCaixa();
}, {
    timezone: 'America/Sao_Paulo'
});


cron.schedule('00 4 * * *', () => {
    log(`🚀 Executando job ItemVenda às ${new Date().toLocaleTimeString()}`, 'CronJob');
    ExecuteJobItemVenda();
}, {
    timezone: 'America/Sao_Paulo'
});

cron.schedule('30 4 * * *', () => {
    log(`🚀 Executando job Consolidation às ${new Date().toLocaleTimeString()}`, 'CronJob');
    ExecuteJobConsolidation();
}, {
    timezone: 'America/Sao_Paulo'
});

cron.schedule('00 5 * * *', () => {
    log(`🚀 Executando job Doc Saida às ${new Date().toLocaleTimeString()}`, 'CronJob');
    ExecuteJobDocSaida();
}, {
    timezone: 'America/Sao_Paulo'
});

cron.schedule('00 7 * * *', () => {
    log(`🚀 Executando disparo para faturamento ${new Date().toLocaleTimeString()}`, 'CronJob');
    gerarFilaWhatsapp();
}, {
    timezone: 'America/Sao_Paulo'
});

cron.schedule('00 9 * * *', () => {
    log(`🚀 Executando job Fluxo de Estoque às ${new Date().toLocaleTimeString()}`, 'CronJob');
    ExecuteJobFluxoEstoque();
}, {
    timezone: 'America/Sao_Paulo'
});

cron.schedule('0 15 * * 1', () => {
    log(`🚀 Executando disparo para CMV ${new Date().toLocaleTimeString()}`, 'CronJob');
    gerarFilaWhatsappCMV();
}, {
    timezone: 'America/Sao_Paulo'
});

cron.schedule('0 11 * * 1', () => {
    log(`🚀 Executando disparo para relatório semanal ${new Date().toLocaleTimeString()}`, 'CronJob');
    SendReportPdfWithResumo();
}, {
    timezone: 'America/Sao_Paulo'
});

processQueueWhatsapp();


