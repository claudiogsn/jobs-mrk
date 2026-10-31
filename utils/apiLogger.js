// utils/apiLogger.js
// Log das integrações (menew, php, tecnospeed...). Antes ia para logs/<integracao>.log em disco;
// agora vai só para o logger estruturado (stdout -> CloudWatch): o container não guarda arquivos.
require('dotenv').config();
const { getLogger } = require('@mrksolucoes/observability');

function appendApiLog(filename, content) {
    try {
        getLogger().debug(`[api:${filename}] ${content}`, { integration: filename });
    } catch (_) { /* nunca deixar o log derrubar o fluxo */ }
}

module.exports = {
    appendApiLog
};
