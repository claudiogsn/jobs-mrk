require('dotenv').config();
const { log } = require('../utils/logger');
const { consumeFromQueue, connect, QUEUES } = require('../utils/rabbitmq');
const { getConnection } = require('../utils/utils');

async function ExecuteJobTelemetria() {
    log('📡 Iniciando worker de telemetria via RabbitMQ...', 'workerTelemetria');

    await connect();

    await consumeFromQueue(QUEUES.TELEMETRIA, async (payload) => {
        let conn;
        try {
            conn = await getConnection();

            const query = `
                INSERT INTO api_access_logs 
                (user_login, method_name, status_code, execution_time_ms, request_data, response_data, ip_address, created_at) 
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            `;

            await conn.execute(query, [
                payload.user || 'anonymous',
                payload.method || 'unknown',
                payload.status || 0,
                payload.exec_ms || 0,
                JSON.stringify(payload.request || {}),
                JSON.stringify(payload.response || {}),
                payload.ip || '0.0.0.0',
                payload.date || new Date()
            ]);

            log(`✅ Log de telemetria gravado: ${payload.method || 'unknown'}`, 'workerTelemetria');
            return true; // ACK
        } catch (err) {
            log(`❌ Erro ao processar log de telemetria: ${err.message}`, 'workerTelemetria');
            return false; // NACK - reenfileira
        } finally {
            if (conn) await conn.end();
        }
    }, { prefetch: 10 }); // Processa até 10 por vez (como no SQS original)
}

module.exports = { ExecuteJobTelemetria };

if (require.main === module) {
    ExecuteJobTelemetria();
}