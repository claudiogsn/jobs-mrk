'use strict';

/**
 * Logger central baseado em Pino.
 *
 * - Saída 100% JSON estruturado.
 * - Campos base fixos (service/environment/version/hostname/pid).
 * - Campos de correlação injetados automaticamente por mixin a partir do
 *   AsyncLocalStorage (worker, executionId, requestId, correlationId, tenantId,
 *   userId, jobId) e do span ativo do OpenTelemetry (traceId, spanId).
 * - Serialização de erro preservando SEMPRE a stack original e extraindo
 *   type/file/line.
 *
 * A instância é singleton: a primeira chamada a `getLogger()` constrói; as demais
 * reaproveitam. Nunca usar console.* — sempre este logger.
 */

const pino = require('pino');
const { loadConfig } = require('../config/env');
const { getContext } = require('./context');

let instance = null;

// Nota: traceId/spanId/traceFlags são injetados automaticamente pelo
// @opentelemetry/instrumentation-pino (configurado em camelCase no otel/sdk.js)
// quando há um span ativo. Não os duplicamos aqui.

/**
 * Serializa um Error preservando a stack e extraindo arquivo/linha da primeira
 * frame do stack ("at func (/caminho/arquivo.js:linha:coluna)").
 */
function serializeError(err) {
    if (!err || typeof err !== 'object') return undefined;
    const stack = err.stack || '';
    const frame = stack.split('\n').find((l) => l.includes(':') && /\d+:\d+/.test(l));
    let file = null;
    let line = null;
    if (frame) {
        const m = frame.match(/\(?([^()\s]+):(\d+):\d+\)?\s*$/);
        if (m) {
            file = m[1];
            line = Number(m[2]);
        }
    }
    return {
        type: err.name || err.constructor?.name || 'Error',
        message: err.message,
        code: err.code,
        file,
        line,
        stack,
    };
}

function buildLogger() {
    const cfg = loadConfig();

    const base = {
        service: cfg.serviceName,
        environment: cfg.environment,
        version: cfg.serviceVersion,
        hostname: cfg.hostname,
        pid: cfg.pid,
    };

    return pino({
        level: cfg.logLevel,
        base,
        timestamp: pino.stdTimeFunctions.isoTime,
        // Garante o nível como string ("info") no campo `level`.
        formatters: {
            level(label) {
                return { level: label };
            },
        },
        // Injetado em TODO log: contexto de execução (worker, executionId, requestId, etc.).
        mixin() {
            return getContext();
        },
    });
}

/** Retorna o singleton do logger Pino cru (com todos os métodos nativos). */
function getPino() {
    if (!instance) instance = buildLogger();
    return instance;
}

// Campos de correlação do contrato: vão top-level (não dentro de `metadata`).
const PROMOTED_FIELDS = new Set([
    'worker', 'executionId', 'jobId', 'requestId', 'correlationId', 'tenantId', 'userId',
]);

/**
 * Normaliza a chamada `(messageOrError, metadata?)` para o formato Pino `(obj, msg)`.
 * - Se o 1º argumento for Error, vira { error } + usa a message do erro.
 * - Campos de correlação conhecidos (PROMOTED_FIELDS) vão top-level.
 * - Um campo `error` (Error) é serializado preservando a stack.
 * - O restante vai sob a chave `metadata`.
 */
function emit(level, messageOrError, fields) {
    const p = getPino();
    const obj = {};
    let message;

    if (messageOrError instanceof Error) {
        obj.error = serializeError(messageOrError);
        message = messageOrError.message;
    } else {
        message = messageOrError;
    }

    if (fields && typeof fields === 'object') {
        const metadata = {};
        for (const [key, value] of Object.entries(fields)) {
            if (key === 'error' && value instanceof Error) {
                obj.error = serializeError(value);
            } else if (PROMOTED_FIELDS.has(key)) {
                obj[key] = value;
            } else {
                metadata[key] = value;
            }
        }
        if (Object.keys(metadata).length > 0) obj.metadata = metadata;
    }

    p[level](obj, message);
}

/**
 * Logger padronizado exposto ao restante da aplicação.
 * Métodos: trace, debug, info, warn, error, fatal.
 * Assinatura: (message: string | Error, metadata?: object)
 */
const logger = {
    trace: (m, meta) => emit('trace', m, meta),
    debug: (m, meta) => emit('debug', m, meta),
    info: (m, meta) => emit('info', m, meta),
    warn: (m, meta) => emit('warn', m, meta),
    error: (m, meta) => emit('error', m, meta),
    fatal: (m, meta) => emit('fatal', m, meta),
    /** Cria um logger-filho com campos fixos (ex.: { worker }). */
    child: (bindings) => getPino().child(bindings),
    raw: getPino,
};

function getLogger() {
    return logger;
}

module.exports = { getLogger, getPino, serializeError };
