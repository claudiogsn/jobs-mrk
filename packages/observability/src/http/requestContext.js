'use strict';

/**
 * Middleware Express de contexto de requisição.
 *
 * Para cada request:
 *  - reaproveita ou gera um requestId (header x-request-id) e um correlationId
 *    (header x-correlation-id, cai no requestId se ausente);
 *  - injeta { requestId, correlationId } no contexto (AsyncLocalStorage) para que
 *    todo log da requisição os carregue;
 *  - traceId/spanId vêm automaticamente do span criado pela auto-instrumentação HTTP;
 *  - devolve o requestId no header de resposta;
 *  - loga início e fim da requisição com método, rota, status e duração.
 *
 * A propagação de trace para chamadas HTTP externas (axios/fetch) é automática via
 * auto-instrumentação (header W3C `traceparent`).
 */

const { randomUUID } = require('crypto');
const { storage } = require('../logger/context');
const { getLogger } = require('../logger/logger');

function requestContextMiddleware(req, res, next) {
    const log = getLogger();
    const requestId = req.headers['x-request-id'] || randomUUID();
    const correlationId = req.headers['x-correlation-id'] || requestId;

    const ctx = { requestId, correlationId };
    // Permite que rotas autenticadas enriqueçam o contexto depois (ex.: req.userId).
    res.setHeader('x-request-id', requestId);

    storage.run({ ...(storage.getStore() || {}), ...ctx }, () => {
        const startedAt = Date.now();
        log.info(`➡️ ${req.method} ${req.originalUrl}`, {
            http: { method: req.method, route: req.originalUrl },
        });

        res.on('finish', () => {
            const durationMs = Date.now() - startedAt;
            const level = res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'warn' : 'info';
            log[level](`⬅️ ${req.method} ${req.originalUrl} ${res.statusCode}`, {
                http: { method: req.method, route: req.originalUrl, status: res.statusCode },
                durationMs,
            });
        });

        next();
    });
}

module.exports = { requestContextMiddleware };
