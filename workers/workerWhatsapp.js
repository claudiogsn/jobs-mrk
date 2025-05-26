require('dotenv').config();
const { log } = require('../utils/logger');
const { SQSClient, ReceiveMessageCommand, DeleteMessageCommand } = require('@aws-sdk/client-sqs');
const axios = require('axios');

const sqs = new SQSClient({
    region: process.env.AWS_REGION,
    credentials: {
        accessKeyId: process.env.AWS_ACCESS_KEY_ID,
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY
    }
});

async function sendWhatsappMessage(data) {
    const { telefone, mensagem } = data;

    try {
        const response = await axios.post(
            `${process.env.ZAPI_BASE_URL}/instances/${process.env.ZAPI_INSTANCE_ID}/token/${process.env.ZAPI_INSTANCE_TOKEN}/send-text`,
            {
                phone: telefone,
                message: mensagem
            },
            {
                headers: {
                    'Content-Type': 'application/json',
                    'Client-Token': process.env.ZAPI_CLIENT_TOKEN
                }
            }
        );

        log(`✅ Mensagem enviada via Z-API para ${telefone}`, 'workerWhatsapp');
        return true;
    } catch (error) {
        log('❌ Erro ao enviar mensagem via Z-API: ' + error.message, 'workerWhatsapp');
        return false;
    }
}

async function processQueue() {
    while (true) {
        try {
            const command = new ReceiveMessageCommand({
                QueueUrl: process.env.WHATSAPP_QUEUE_URL,
                MaxNumberOfMessages: 1,
                WaitTimeSeconds: 10,
                VisibilityTimeout: 300
            });

            const data = await sqs.send(command);

            if (!data.Messages || data.Messages.length === 0) {
                log('📭 Nenhuma mensagem na fila, aguardando...', 'workerWhatsapp');
                continue;
            }

            for (const message of data.Messages) {
                const body = JSON.parse(message.Body);
                const payload = typeof body === 'string' ? JSON.parse(body) : body;

                log('📨 Processando mensagem para ' + payload.telefone, 'workerWhatsapp');

                const success = await sendWhatsappMessage(payload);

                if (success) {
                    await sqs.send(new DeleteMessageCommand({
                        QueueUrl: process.env.WHATSAPP_QUEUE_URL,
                        ReceiptHandle: message.ReceiptHandle
                    }));
                    log('🗑️ Mensagem deletada da fila com sucesso.', 'workerWhatsapp');
                } else {
                    log('⚠️ Envio falhou, mensagem NÃO deletada.', 'workerWhatsapp');
                }
            }
        } catch (err) {
            log('❌ Erro no processamento da fila: ' + err.message, 'workerWhatsapp');
        }
    }
}

module.exports = { processQueueWhatsapp: processQueue };

if (require.main === module) {
    processQueue();
}
