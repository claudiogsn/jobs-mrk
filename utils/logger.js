/**
 * Adapter de compatibilidade.
 *
 * Mantém a assinatura histórica `log(message, workerName)` usada em toda a base,
 * mas delega para o logger central de @mrksolucoes/observability (Pino/JSON +
 * correlação + export OTLP). Assim nenhum dos chamadores existentes precisa mudar.
 *
 * `getLogs()` continua devolvendo um buffer em memória dos últimos logs (consumido
 * pela rota /jobs/stdout e pelo dashboard), preservando o comportamento atual.
 */

const { getLogger } = require('@mrksolucoes/observability');

const logger = getLogger();
const logs = [];
const MAX = 2000;

function log(message, workerName = 'worker') {
    logger.info(message, { worker: workerName });

    logs.push(`[${workerName}] - ${message}`);
    if (logs.length > MAX) logs.shift();
}

function getLogs() {
    return logs;
}

module.exports = { log, getLogs };
