'use strict';

/**
 * Configuração centralizada da observabilidade — lida EXCLUSIVAMENTE de variáveis de ambiente.
 *
 * Nenhum valor sensível é hardcoded. Os defaults servem apenas como conveniência
 * para o ambiente padrão (produção MRK). Tudo pode ser sobrescrito por env, o que
 * permite alternar entre desenvolvimento, homologação e produção sem tocar no código.
 *
 * Mantém-se proposital e estritamente fiel às variáveis padrão do OpenTelemetry
 * (OTEL_*) para que o SDK também as reconheça nativamente.
 */

const os = require('os');

function bool(value, fallback) {
    if (value === undefined || value === null || value === '') return fallback;
    return ['1', 'true', 'yes', 'on'].includes(String(value).trim().toLowerCase());
}

function str(value, fallback) {
    if (value === undefined || value === null || value === '') return fallback;
    return String(value);
}

/**
 * Lê a configuração efetiva no momento da chamada (process.env já carregado).
 * @returns {{
 *   enabled: boolean,
 *   serviceName: string,
 *   serviceVersion: string,
 *   environment: string,
 *   hostname: string,
 *   pid: number,
 *   logLevel: string,
 *   otlp: { endpoint: string, protocol: string, headers: string, resourceAttributes: string }
 * }}
 */
function loadConfig() {
    const environment = str(process.env.NODE_ENV, 'development');

    return {
        // Liga/desliga toda a stack de OTel. Desligado => app roda idêntico ao original.
        enabled: bool(process.env.OTEL_ENABLED, true),

        // Identidade do serviço — usada no resource do OTel e nos campos base do log.
        serviceName: str(process.env.OTEL_SERVICE_NAME, str(process.env.npm_package_name, 'node-app')),
        serviceVersion: str(process.env.OTEL_SERVICE_VERSION, str(process.env.npm_package_version, '0.0.0')),
        environment,
        hostname: str(process.env.HOSTNAME, os.hostname()),
        pid: process.pid,

        // Nível mínimo de log (pino): trace|debug|info|warn|error|fatal|silent
        logLevel: str(process.env.LOG_LEVEL, environment === 'production' ? 'info' : 'debug'),

        otlp: {
            // Porta 4318 = ingest OTLP/HTTP do SigNoz (a raiz :443 serve a UI, não aceita OTLP).
            // Recomenda-se expor via HTTPS (proxy reverso /v1/*) e então trocar esta env.
            endpoint: str(process.env.OTEL_EXPORTER_OTLP_ENDPOINT, 'http://monitor.mrksolucoes.com.br:4318'),
            protocol: str(process.env.OTEL_EXPORTER_OTLP_PROTOCOL, 'http/protobuf'),
            // ex.: "Authorization=Bearer xxx,X-Scope-OrgID=mrk"
            headers: str(process.env.OTEL_EXPORTER_OTLP_HEADERS, ''),
            // ex.: "deployment.environment=producao,team=plataforma"
            resourceAttributes: str(process.env.OTEL_RESOURCE_ATTRIBUTES, ''),
        },
    };
}

module.exports = { loadConfig, bool, str };
