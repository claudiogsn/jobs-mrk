require('dotenv').config();
require('./server'); // Express

const { log } = require('./utils/logger');
const { processQueueWhatsapp } = require('./workers/workerWhatsapp');
const { agendarJobsDinamicos } = require('./cron/agendador');

(async () => {
    log('🟢 Iniciando agendador de tarefas....', 'CronJob');
    await agendarJobsDinamicos();
    processQueueWhatsapp();
})();
