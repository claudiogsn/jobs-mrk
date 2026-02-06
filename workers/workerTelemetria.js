require('dotenv').config();
const { log } = require('../utils/logger');
const { SQSClient, ReceiveMessageCommand, DeleteMessageCommand } = require('@aws-sdk/client-sqs');
const { getConnection } = require('../utils/utils');

const sqs = new SQSClient({
    region: process.env.AWS_REGION,
    credentials: {
        accessKeyId: process.env.AWS_ACCESS_KEY_ID,
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY
    }
});

async function ExecuteJobTelemetria() {
    log('📡 Iniciando processamento de logs do SQS...', 'workerTelemetria');

    let conn;
    try {
        conn = await getConnection();

        const command = new ReceiveMessageCommand({
            QueueUrl: process.env.AWS_QUEUE_URL,
            MaxNumberOfMessages: 10,
            WaitTimeSeconds: 5
        });

        const data = await sqs.send(command);

        if (!data.Messages || data.Messages.length === 0) {
            return; // Fila vazia
        }

        for (const message of data.Messages) {
            try {
                const body = JSON.parse(message.Body);
                // O PHP envia um JSON, garantimos que é um objeto
                const payload = typeof body === 'string' ? JSON.parse(body) : body;

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

                // Deleta da fila após gravar no banco
                await sqs.send(new DeleteMessageCommand({
                    QueueUrl: process.env.AWS_QUEUE_URL,
                    ReceiptHandle: message.ReceiptHandle
                }));

            } catch (errJson) {
                log(`❌ Erro ao processar mensagem individual: ${errJson.message}`, 'workerTelemetria');
            }
        }

        log(`✅ Processadas ${data.Messages.length} mensagens de log.`, 'workerTelemetria');

    } catch (err) {
        log(`🔥 Erro no Worker Telemetria: ${err.message}`, 'workerTelemetria');
    } finally {
        if (conn) await conn.end();
    }
}

module.exports = { ExecuteJobTelemetria };