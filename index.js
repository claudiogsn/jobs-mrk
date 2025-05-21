require('dotenv').config();
require('./server');
const cron = require('node-cron');
const { ExecuteJobCaixa } = require('./workers/workerMovimentoCaixa');
const { ExecuteJobItemVenda } = require('./workers/workerItemVenda');
const {ExecuteJobConsolidation} = require("./workers/workerConsolidateSales");
const {ExecuteJobDocSaida} = require("./workers/workerCreateDocSaida");

console.log('🕓 Agendador iniciado. Esperando horários programados...');


cron.schedule('*/30 * * * *', () => {
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


