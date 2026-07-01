'use strict';

/**
 * @mrksolucoes/observability — API pública.
 *
 * Camada reutilizável de observabilidade para projetos Node.js:
 *  - Logger estruturado (Pino/JSON) com correlação automática;
 *  - OpenTelemetry (traces + métricas + logs) via OTLP;
 *  - Envelope de execução de workers (executionId + início/fim/duração/erro);
 *  - Middleware de contexto de requisição HTTP.
 *
 * Toda configuração é feita por variáveis de ambiente — ver README/.env.example.
 *
 * Padrão de inicialização do OTel: usar o preload `-r @mrksolucoes/observability/register`.
 * `initObservability()` existe como alternativa programática (deve ser chamada o mais
 * cedo possível, antes de requerer http/express/mysql2/amqplib).
 */

const { startOtel, getSdk } = require('./otel/sdk');
const { getLogger, getPino, serializeError } = require('./logger/logger');
const { withContext, setContext, getContext } = require('./logger/context');
const { runWithExecution } = require('./workers/withExecution');
const { requestContextMiddleware } = require('./http/requestContext');
const { loadConfig } = require('./config/env');

/** Inicializa o OpenTelemetry programaticamente (alternativa ao preload `-r`). */
function initObservability() {
    return startOtel();
}

module.exports = {
    initObservability,
    getSdk,
    getLogger,
    getPino,
    serializeError,
    runWithExecution,
    requestContextMiddleware,
    withContext,
    setContext,
    getContext,
    loadConfig,
};
