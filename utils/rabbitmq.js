const amqp = require('amqplib');
const { log } = require('./logger');

const RABBITMQ_URL = process.env.RABBITMQ_URL || 'amqp://guest:guest@localhost:5672';

// Filas usadas pelo sistema
const QUEUES = {
    WHATSAPP: process.env.RABBITMQ_QUEUE_WHATSAPP || 'whatsapp_messages',
    TELEMETRIA: process.env.RABBITMQ_QUEUE_TELEMETRIA || 'telemetria_logs',
};

let connection = null;
let channel = null;
let reconnecting = false;

async function connect() {
    if (channel && connection) return { connection, channel };

    try {
        connection = await amqp.connect(RABBITMQ_URL);
        channel = await connection.createChannel();

        // Garante que as filas existam (durable = sobrevive restart do RabbitMQ)
        for (const queue of Object.values(QUEUES)) {
            await channel.assertQueue(queue, {
                durable: true,
            });
        }

        log('✅ Conectado ao RabbitMQ com sucesso', 'rabbitmq');

        // Listeners de erro e fechamento para auto-reconexão
        connection.on('error', (err) => {
            log(`❌ Erro na conexão RabbitMQ: ${err.message}`, 'rabbitmq');
            connection = null;
            channel = null;
            scheduleReconnect();
        });

        connection.on('close', () => {
            log('⚠️ Conexão RabbitMQ fechada', 'rabbitmq');
            connection = null;
            channel = null;
            scheduleReconnect();
        });

        return { connection, channel };
    } catch (err) {
        log(`🔥 Falha ao conectar no RabbitMQ: ${err.message}`, 'rabbitmq');
        connection = null;
        channel = null;
        throw err;
    }
}

function scheduleReconnect() {
    if (reconnecting) return;
    reconnecting = true;
    log('🔄 Tentando reconectar ao RabbitMQ em 5s...', 'rabbitmq');
    setTimeout(async () => {
        reconnecting = false;
        try {
            await connect();
        } catch (err) {
            log(`🔥 Reconexão falhou: ${err.message}`, 'rabbitmq');
            scheduleReconnect();
        }
    }, 5000);
}

/**
 * Retorna o channel ativo (reconecta se necessário)
 */
async function getChannel() {
    if (channel) return channel;
    const result = await connect();
    return result.channel;
}

/**
 * Publica uma mensagem em uma fila
 * @param {string} queue - Nome da fila (use QUEUES.WHATSAPP, QUEUES.TELEMETRIA, etc)
 * @param {object} payload - Objeto que será serializado como JSON
 */
async function publishToQueue(queue, payload) {
    const ch = await getChannel();
    const content = Buffer.from(JSON.stringify(payload));
    ch.sendToQueue(queue, content, {
        persistent: true, // mensagem sobrevive restart do RabbitMQ
    });
}

/**
 * Consome mensagens de uma fila com callback
 * @param {string} queue - Nome da fila
 * @param {function} handler - async function(payload) => deve retornar true para ACK, false para NACK
 * @param {object} options - { prefetch: 1 } controla quantas msgs processar por vez
 */
async function consumeFromQueue(queue, handler, options = {}) {
    const ch = await getChannel();
    const prefetch = options.prefetch || 1;

    await ch.prefetch(prefetch);

    log(`👂 Ouvindo fila "${queue}" (prefetch: ${prefetch})...`, 'rabbitmq');

    ch.consume(queue, async (msg) => {
        if (!msg) return;

        try {
            const payload = JSON.parse(msg.content.toString());
            const success = await handler(payload);

            if (success) {
                ch.ack(msg);
            } else {
                // Rejeita e reenfileira para tentar novamente
                ch.nack(msg, false, true);
            }
        } catch (err) {
            log(`❌ Erro ao processar mensagem da fila "${queue}": ${err.message}`, 'rabbitmq');
            // Rejeita e reenfileira
            ch.nack(msg, false, true);
        }
    });
}

/**
 * Fecha conexão (para graceful shutdown)
 */
async function closeConnection() {
    try {
        if (channel) await channel.close();
        if (connection) await connection.close();
        log('🔌 Conexão RabbitMQ encerrada', 'rabbitmq');
    } catch (err) {
        log(`⚠️ Erro ao fechar conexão: ${err.message}`, 'rabbitmq');
    } finally {
        channel = null;
        connection = null;
    }
}

module.exports = {
    QUEUES,
    connect,
    getChannel,
    publishToQueue,
    consumeFromQueue,
    closeConnection,
};