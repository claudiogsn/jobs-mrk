'use strict';

/**
 * Inicialização do OpenTelemetry (traces + métricas + logs) com export OTLP direto.
 *
 * IMPORTANTE: este módulo precisa ser carregado ANTES dos módulos instrumentados
 * (http, express, mysql2, amqplib, pino). É isso que o `register.js` garante via
 * `node -r @mrksolucoes/observability/register`.
 *
 * Toda a configuração vem de variáveis de ambiente (ver config/env.js). Os exporters
 * OTLP leem OTEL_EXPORTER_OTLP_ENDPOINT / OTEL_EXPORTER_OTLP_HEADERS nativamente e
 * anexam os paths padrão (/v1/traces, /v1/metrics, /v1/logs).
 */

const { loadConfig } = require('../config/env');

let started = false;
let sdkRef = null;

function buildResource(cfg) {
    const attrs = {
        'service.name': cfg.serviceName,
        'service.version': cfg.serviceVersion,
        'deployment.environment': cfg.environment,
        'deployment.environment.name': cfg.environment,
        'host.name': cfg.hostname,
    };
    // API nova (>=1.29). Fallback silencioso caso a versão exporte de outra forma.
    try {
        const { resourceFromAttributes } = require('@opentelemetry/resources');
        if (typeof resourceFromAttributes === 'function') return resourceFromAttributes(attrs);
    } catch (_) { /* segue para fallback */ }
    try {
        const { Resource } = require('@opentelemetry/resources');
        if (Resource) return new Resource(attrs);
    } catch (_) { /* sem resource explícito — SDK monta a partir do env */ }
    return undefined;
}

/**
 * Inicializa o SDK do OpenTelemetry. Idempotente. No-op se OTEL_ENABLED=false.
 * @returns {boolean} true se iniciou, false se desabilitado/já iniciado.
 */
function startOtel() {
    if (started) return false;
    const cfg = loadConfig();

    if (!cfg.enabled) {
        // Observabilidade desligada: app roda idêntico ao comportamento original.
        // eslint-disable-next-line no-console
        console.log('[observability] OTEL_ENABLED=false — OpenTelemetry desativado.');
        return false;
    }

    const { NodeSDK } = require('@opentelemetry/sdk-node');
    const { OTLPTraceExporter } = require('@opentelemetry/exporter-trace-otlp-proto');
    const { OTLPMetricExporter } = require('@opentelemetry/exporter-metrics-otlp-proto');
    const { OTLPLogExporter } = require('@opentelemetry/exporter-logs-otlp-proto');
    const { PeriodicExportingMetricReader } = require('@opentelemetry/sdk-metrics');
    const { BatchLogRecordProcessor } = require('@opentelemetry/sdk-logs');
    const { getNodeAutoInstrumentations } = require('@opentelemetry/auto-instrumentations-node');

    const instrumentations = [
        getNodeAutoInstrumentations({
            // fs é extremamente ruidoso e sem valor analítico aqui.
            '@opentelemetry/instrumentation-fs': { enabled: false },
            // Correlaciona logs do Pino com o trace ativo e faz o bridge para o pipeline OTLP de logs.
            // logKeys em camelCase para casar com o contrato de campos (traceId/spanId).
            '@opentelemetry/instrumentation-pino': {
                enabled: true,
                logKeys: { traceId: 'traceId', spanId: 'spanId', traceFlags: 'traceFlags' },
            },
        }),
    ];

    // Métricas de runtime (event loop lag, heap, GC). Opcional — não derruba se ausente.
    try {
        const { RuntimeNodeInstrumentation } = require('@opentelemetry/instrumentation-runtime-node');
        instrumentations.push(new RuntimeNodeInstrumentation());
    } catch (_) { /* pacote ausente: segue sem métricas de runtime */ }

    const sdk = new NodeSDK({
        resource: buildResource(cfg),
        traceExporter: new OTLPTraceExporter(),
        metricReader: new PeriodicExportingMetricReader({
            exporter: new OTLPMetricExporter(),
            exportIntervalMillis: Number(process.env.OTEL_METRIC_EXPORT_INTERVAL || 60000),
        }),
        logRecordProcessors: [new BatchLogRecordProcessor(new OTLPLogExporter())],
        instrumentations,
    });

    sdk.start();
    started = true;
    sdkRef = sdk;

    // eslint-disable-next-line no-console
    console.log(
        `[observability] OpenTelemetry iniciado — service="${cfg.serviceName}" env="${cfg.environment}" endpoint="${cfg.otlp.endpoint}"`
    );

    const shutdown = () => {
        sdk.shutdown().catch(() => { /* ignora erro no shutdown */ }).finally(() => process.exit(0));
    };
    process.once('SIGTERM', shutdown);
    process.once('SIGINT', shutdown);

    return true;
}

function getSdk() {
    return sdkRef;
}

module.exports = { startOtel, getSdk };
