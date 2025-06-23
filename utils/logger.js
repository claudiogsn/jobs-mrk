const { DateTime } = require('luxon');

const logs = []; // Guardar logs em memória

function log(message, workerName = 'worker') {
    const timestamp = DateTime.now()
        .setZone('America/Fortaleza')
        .toFormat('yyyy-MM-dd HH:mm:ss');

    const fullMessage = `[${workerName}] - ${message}`;

    console.log(fullMessage);

    // Guarda no array (máximo de 1000 entradas, por exemplo)
    logs.push(fullMessage);
    if (logs.length > 2000) {
        logs.shift(); // Remove o mais antigo para não explodir a memória
    }
}

function getLogs() {
    return logs;
}

module.exports = { log, getLogs };
