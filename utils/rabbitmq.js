const amqp = require('amqplib');
const { log } = require('./logger');

const RABBITMQ_URL = process.env.RABBITMQ_URL || 'amqp://guest:guest@localhost:5672';

// Filas usadas pelo sistema
const QUEUES = {
    WHATSAPP: process.env.RABBITMQ_QUEUE_WHATSAPP || 'whatsapp_messages',
    TELEMETRIA: process.env.RABBITMQ_QUEUE_TELEMETRIA || 'telemetria_logs',
};

// Exchanges fanout (pub/sub) — usados para sinais entre processos desacoplados.
const EXCHANGES = {
    CRON_RELOAD: 'cron.reload',
};

let connection = null;
let channel = null;
let reconnecting = false;
let connecting = null;

// Consumidores/inscrições registrados. Após uma reconexão eles são refeitos no novo
// channel — sem isso o processo continua "online" no pm2 mas para de consumir.
const subscriptions = [];

async function connect() {
    if (channel && connection) return { connection, channel };
    if (connecting) return connecting;

    connecting = (async () => {
        let conn = null;
        try {
            conn = await amqp.connect(RABBITMQ_URL);
            const ch = await conn.createChannel();

            // Garante que as filas existam (durable = sobrevive restart do RabbitMQ)
            for (const queue of Object.values(QUEUES)) {
                await ch.assertQueue(queue, {
                    durable: true,
                });
            }

            // Listeners de erro e fechamento para auto-reconexão (ignora eventos de
            // conexões antigas, para não derrubar uma conexão nova já estabelecida)
            conn.on('error', (err) => {
                log(`❌ Erro na conexão RabbitMQ: ${err.message}`, 'rabbitmq');
            });

            conn.on('close', () => {
                if (connection !== conn) return;
                log('⚠️ Conexão RabbitMQ fechada', 'rabbitmq');
                connection = null;
                channel = null;
                scheduleReconnect();
            });

            connection = conn;
            channel = ch;

            log('✅ Conectado ao RabbitMQ com sucesso', 'rabbitmq');

            for (const sub of subscriptions) {
                await sub.start(ch);
            }

            return { connection, channel };
        } catch (err) {
            log(`🔥 Falha ao conectar no RabbitMQ: ${err.message}`, 'rabbitmq');
            if (conn) conn.close().catch(() => {});
            connection = null;
            channel = null;
            throw err;
        } finally {
            connecting = null;
        }
    })();

    return connecting;
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

    const sub = { start: (c) => startConsumer(c, queue, handler, prefetch) };
    subscriptions.push(sub);
    await sub.start(ch);
}

async function startConsumer(ch, queue, handler, prefetch) {
    await ch.prefetch(prefetch);

    log(`👂 Ouvindo fila "${queue}" (prefetch: ${prefetch})...`, 'rabbitmq');

    await ch.consume(queue, async (msg) => {
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
 * Publica uma mensagem num exchange fanout (broadcast para todos os inscritos).
 * Usado, por exemplo, para sinalizar reload de cron entre processos.
 */
async function publishFanout(exchange, payload = {}) {
    const ch = await getChannel();
    await ch.assertExchange(exchange, 'fanout', { durable: false });
    ch.publish(exchange, '', Buffer.from(JSON.stringify(payload)));
}

/**
 * Inscreve um handler num exchange fanout (fila exclusiva/efêmera por processo).
 * Cada processo inscrito recebe uma cópia da mensagem.
 */
async function subscribeFanout(exchange, handler) {
    const ch = await getChannel();

    const sub = { start: (c) => startFanout(c, exchange, handler) };
    subscriptions.push(sub);
    await sub.start(ch);
}

async function startFanout(ch, exchange, handler) {
    await ch.assertExchange(exchange, 'fanout', { durable: false });
    const { queue } = await ch.assertQueue('', { exclusive: true });
    await ch.bindQueue(queue, exchange, '');

    ch.consume(queue, async (msg) => {
        if (!msg) return;
        try {
            const payload = JSON.parse(msg.content.toString() || '{}');
            await handler(payload);
        } catch (err) {
            log(`❌ Erro no handler do fanout "${exchange}": ${err.message}`, 'rabbitmq');
        }
        ch.ack(msg);
    });

    log(`👂 Inscrito no exchange fanout "${exchange}"`, 'rabbitmq');
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
    EXCHANGES,
    connect,
    getChannel,
    publishToQueue,
    consumeFromQueue,
    publishFanout,
    subscribeFanout,
    closeConnection,
};