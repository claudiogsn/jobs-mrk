require('dotenv').config();
// Inicializa a observabilidade ANTES de qualquer módulo instrumentado (express, mysql2, amqplib).
// Idempotente: se já iniciado via `-r @mrksolucoes/observability/register`, é no-op.
require('@mrksolucoes/observability').initObservability();

require('./server'); // Express

const { log } = require('./utils/logger');
const { processQueueWhatsapp } = require('./workers/workerWhatsapp');
const { agendarJobsDinamicos, iniciarListenerReload } = require('./cron/agendador');

(async () => {
    log('🟢 Iniciando agendador de tarefas....', 'CronJob');
    await agendarJobsDinamicos();
    await iniciarListenerReload();
    processQueueWhatsapp();
})();
