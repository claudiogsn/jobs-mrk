'use strict';

/**
 * Envelope de execução para workers/jobs.
 *
 * Para cada execução:
 *  - gera um executionId único (execuções paralelas têm ids distintos);
 *  - abre um span OpenTelemetry (vira o trace raiz do job);
 *  - injeta { worker, executionId, jobId } no contexto (AsyncLocalStorage), de modo
 *    que todo log da execução compartilhe esses identificadores;
 *  - registra automaticamente início, fim, duração (ms), sucesso ou erro;
 *  - NUNCA engole exceções: loga com stack completa, marca o span e RE-LANÇA.
 */

const { randomUUID } = require('crypto');
const { withContext } = require('../logger/context');
const { getLogger } = require('../logger/logger');

// Acesso defensivo ao OTel (funciona com OTEL desligado).
let otelTrace = null;
let SpanStatusCode = { OK: 1, ERROR: 2 };
try {
    const api = require('@opentelemetry/api');
    otelTrace = api.trace;
    SpanStatusCode = api.SpanStatusCode;
} catch (_) { /* sem OTel: segue só com logs */ }

/**
 * @param {string} workerName  nome do worker/job (ex.: 'ExecuteJobCaixa')
 * @param {(ctx: { executionId: string }) => Promise<any>} fn  função a executar
 * @param {object} [opts]
 * @param {string} [opts.jobId]   id do disparo/registro, quando aplicável
 * @param {object} [opts.metadata] metadados adicionais para o log de início/fim
 * @returns {Promise<any>} o retorno de `fn`
 */
async function runWithExecution(workerName, fn, opts = {}) {
    const log = getLogger();
    const executionId = opts.executionId || randomUUID();
    const baseCtx = { worker: workerName, executionId };
    if (opts.jobId !== undefined) baseCtx.jobId = opts.jobId;

    const exec = async () => {
        const startedAt = Date.now();
        // `worker`, `executionId` e `jobId` já vão top-level via contexto (withContext).
        log.info(`▶️ Início: ${workerName}`, opts.metadata);

        try {
            const result = await fn({ executionId });
            const durationMs = Date.now() - startedAt;
            log.info(`✅ Fim: ${workerName}`, { status: 'success', durationMs, ...(opts.metadata || {}) });
            return result;
        } catch (err) {
            const durationMs = Date.now() - startedAt;
            // Nunca perde a stack: o serializer do logger inclui type/file/line/stack.
            log.error(err, { status: 'error', durationMs });
            throw err;
        }
    };

    // Sem OTel: roda só com o contexto de log.
    if (!otelTrace) {
        return withContext(baseCtx, exec);
    }

    const tracer = otelTrace.getTracer('@mrksolucoes/observability');
    return tracer.startActiveSpan(`worker:${workerName}`, async (span) => {
        span.setAttribute('worker.name', workerName);
        span.setAttribute('execution.id', executionId);
        if (opts.jobId !== undefined) span.setAttribute('job.id', String(opts.jobId));

        return withContext(baseCtx, async () => {
            try {
                const result = await exec();
                span.setStatus({ code: SpanStatusCode.OK });
                return result;
            } catch (err) {
                span.recordException(err);
                span.setStatus({ code: SpanStatusCode.ERROR, message: err.message });
                throw err;
            } finally {
                span.end();
            }
        });
    });
}

module.exports = { runWithExecution };
