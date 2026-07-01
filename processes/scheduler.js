/**
 * Processo: Agendador (cron jobs dinâmicos).
 *
 * Responsabilidade única: carregar e executar os disparos da tabela `disparos`.
 * Escuta o sinal de reload (fanout) para recarregar sem reiniciar — disparado pela
 * rota /jobs/reload-cron (que roda no processo da API).
 */

require('dotenv').config();
require('@mrksolucoes/observability').initObservability();

const { getLogger } = require('@mrksolucoes/observability');
const { agendarJobsDinamicos, iniciarListenerReload } = require('../cron/agendador');

const log = getLogger();

(async () => {
    log.info('🟢 Iniciando processo do agendador...', { worker: 'scheduler' });
    await agendarJobsDinamicos();
    await iniciarListenerReload();
})();
