/**
 * Configuração PM2 — processos desacoplados.
 *
 * Cada papel roda isolado (uma falha não derruba os demais). Todos inicializam o
 * OpenTelemetry via preload `-r` (dotenv primeiro, depois o register), com
 * OTEL_SERVICE_NAME próprio para aparecerem separados no SigNoz.
 *
 * Para rodar tudo num único processo (dev), use: `npm start` (index.js).
 */

const node_args = '-r dotenv/config -r @mrksolucoes/observability/register';

const common = {
    cwd: __dirname,
    node_args,
    log_date_format: 'YYYY-MM-DD HH:mm:ss',
    autorestart: true,
    max_restarts: 10,
    env: {
        NODE_ENV: process.env.NODE_ENV || 'production',
    },
};

module.exports = {
    apps: [
        {
            ...common,
            name: 'jobs-mrk-api',
            script: 'processes/api.js',
            env: { ...common.env, OTEL_SERVICE_NAME: 'jobs-mrk-api' },
        },
        {
            ...common,
            name: 'jobs-mrk-scheduler',
            script: 'processes/scheduler.js',
            env: { ...common.env, OTEL_SERVICE_NAME: 'jobs-mrk-scheduler' },
        },
        {
            ...common,
            name: 'jobs-mrk-consumer',
            script: 'processes/consumer.js',
            env: { ...common.env, OTEL_SERVICE_NAME: 'jobs-mrk-consumer' },
        },
    ],
};
