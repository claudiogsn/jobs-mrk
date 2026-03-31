require('dotenv').config();
const { log } = require('../utils/logger');
const { consumeFromQueue, connect, QUEUES } = require('../utils/rabbitmq');
const axios = require('axios');

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

async function processQueueWhatsapp() {
    await connect();

    log('🚀 Worker WhatsApp iniciado - aguardando mensagens...', 'workerWhatsapp');

    await consumeFromQueue(QUEUES.WHATSAPP, async (payload) => {
        log('📨 Processando mensagem para ' + payload.telefone, 'workerWhatsapp');

        const success = await sendWhatsappMessage(payload);

        if (success) {
            log('✅ Mensagem processada com sucesso.', 'workerWhatsapp');
        } else {
            log('⚠️ Envio falhou, mensagem será reenfileirada.', 'workerWhatsapp');
        }

        return success; // true = ACK, false = NACK (reenfileira)
    }, { prefetch: 1 });
}

module.exports = { processQueueWhatsapp };

if (require.main === module) {
    processQueueWhatsapp();
}