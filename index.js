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


log('🕓 Iniciando agendador de tarefas...', 'INDEX');

cron.schedule('*/30 * * * *', () => {
    log(`🔁 Executando job Caixa (cron */30) - ${new Date().toLocaleTimeString()}`, 'INDEX');
    ExecuteJobCaixa();
}, {
    timezone: 'America/Sao_Paulo'
});


cron.schedule('00 4 * * *', () => {
    log(`🚀 Executando job ItemVenda às ${new Date().toLocaleTimeString()}`, 'INDEX');
    ExecuteJobItemVenda();
}, {
    timezone: 'America/Sao_Paulo'
});

cron.schedule('30 4 * * *', () => {
    log(`🚀 Executando job Consolidation às ${new Date().toLocaleTimeString()}`, 'INDEX');
    ExecuteJobConsolidation();
}, {
    timezone: 'America/Sao_Paulo'
});

cron.schedule('00 5 * * *', () => {
    log(`🚀 Executando job Doc Saida às ${new Date().toLocaleTimeString()}`, 'INDEX');
    ExecuteJobDocSaida();
}, {
    timezone: 'America/Sao_Paulo'
});

cron.schedule('00 7 * * *', () => {
    log(`🚀 Executando disparo para faturamento ${new Date().toLocaleTimeString()}`, 'INDEX');
    gerarFilaWhatsapp();
}, {
    timezone: 'America/Sao_Paulo'
});

cron.schedule('00 9 * * *', () => {
    log(`🚀 Executando job Fluxo de Estoque às ${new Date().toLocaleTimeString()}`, 'INDEX');
    ExecuteJobFluxoEstoque();
}, {
    timezone: 'America/Sao_Paulo'
});

cron.schedule('0 15 * * 1', () => {
    log(`🚀 Executando disparo para CMV ${new Date().toLocaleTimeString()}`, 'INDEX');
    gerarFilaWhatsappCMV();
}, {
    timezone: 'America/Sao_Paulo'
});

cron.schedule('0 11 * * 1', () => {
    log(`🚀 Executando disparo para relatório semanal ${new Date().toLocaleTimeString()}`, 'INDEX');
    SendReportPdfWithResumo();
}, {
    timezone: 'America/Sao_Paulo'
});

processQueueWhatsapp();


