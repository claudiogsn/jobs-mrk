const { DateTime } = require('luxon');

const logs = [];

function log(message, workerName = 'worker') {
    const timestamp = DateTime.now()
        .setZone('America/Fortaleza')
        .toFormat('yyyy-MM-dd HH:mm:ss');

    const fullMessage = `[${workerName}] - ${message}`;

    console.log(fullMessage);

    logs.push(fullMessage);
    if (logs.length > 2000) {
        logs.shift();
    }
}

function getLogs() {
    return logs;
}

module.exports = { log, getLogs };
