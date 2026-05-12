// utils/apiLogger.js
require('dotenv').config();
const fs = require('fs');
const path = require('path');

const LOG_DIR = path.resolve(__dirname, '../logs');

// Garante que o diretório de logs principal exista
if (!fs.existsSync(LOG_DIR)) {
    fs.mkdirSync(LOG_DIR, { recursive: true });
}

// Agora a função recebe o nome do arquivo (ex: 'menew', 'php', 'tecnospeed')
function appendApiLog(filename, content) {
    const timestamp = new Date().toISOString();
    const logEntry = `[${timestamp}] ${content}\n`;

    // Resolve o caminho dinâmico: ../logs/nome_do_arquivo.log
    const logPath = path.resolve(LOG_DIR, `${filename}.log`);

    // Cria o arquivo caso ele não exista no momento da escrita
    if (!fs.existsSync(logPath)) {
        fs.writeFileSync(logPath, '');
    }

    fs.appendFileSync(logPath, logEntry);
}

module.exports = {
    appendApiLog
};