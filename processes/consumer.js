/**
 * Processo: Consumer (filas RabbitMQ).
 *
 * Responsabilidade única: consumir a fila de mensagens WhatsApp. Falhas aqui não
 * afetam a API nem o scheduler.
 */

require('dotenv').config();
require('@mrksolucoes/observability').initObservability();

const { getLogger } = require('@mrksolucoes/observability');
const { processQueueWhatsapp } = require('../workers/workerWhatsapp');
const { ExecuteJobTelemetria } = require('../workers/workerTelemetria');

const log = getLogger();

(async () => {
    log.info('🟢 Iniciando processo do consumer (WhatsApp & Telemetria)...', { worker: 'consumer' });
    
    await Promise.all([
        processQueueWhatsapp(),
        ExecuteJobTelemetria()
    ]);
})();

