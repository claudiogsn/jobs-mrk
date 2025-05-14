// index.js - Inicializador com agendamentos
require('dotenv').config();
const cron = require('node-cron');
const { processItemVenda } = require('./workers/workerItemVenda');
const { processConsolidation } = require('./workers/workerConsolidateSales');
const { processDocSaida } = require('./workers/workerCreateDocSaida');
const { dispatchFinanceiro } = require('./workers/workerFinanceiro');
require('./server');

console.log('🕓 Agendador iniciado. Esperando horários programados...');

// Às 04:00
cron.schedule('0 4 * * *', () => {
    console.log('🚀 Executando workerItemVenda (04:00)');
    processItemVenda();
});

// Às 04:30
cron.schedule('30 4 * * *', () => {
    console.log('🚀 Executando processConsolidation (04:30)');
    processConsolidation();
});

// Às 05:00
cron.schedule('0 5 * * *', () => {
    console.log('🚀 Executando processDocSaida (05:00)');
    processDocSaida();
});

// Às 05:30
cron.schedule('30 5 * * *', () => {
    console.log('🚀 Iniciando dispatchFinanceiro (05:30)');
    dispatchFinanceiro();
});
