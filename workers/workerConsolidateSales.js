require('dotenv').config();
const { log } = require('../utils/logger');
const { callPHP } = require('../utils/apiLogger');
const { DateTime } = require('luxon');

async function processDocSaida({ group_id, data } = {}) {
  const groupId = parseInt(group_id ?? process.env.GROUP_ID);
  const dataRef = data ?? DateTime.now().minus({ days: 1 }).toISODate();

  const unidades = await callPHP('getUnitsByGroup', { group_id: groupId });

  if (!Array.isArray(unidades) || unidades.length === 0) {
    log('⚠️ Nenhuma unidade encontrada.', 'workerCreateDocSaida');
    return;
  }

  for (const unidade of unidades) {
    const system_unit_id = unidade.system_unit_id;

    try {
      const result = await callPHP('importMovBySalesCons', { system_unit_id, data: dataRef });

      const sucesso = result?.success === true || result?.status === 'success';

      if (!sucesso) {
        log(`❌ Falha ao importar movimentação para unidade ${system_unit_id}: ${result.message}`, 'workerCreateDocSaida');
        continue;
      }

      await callPHP('registerJobExecution', {
        group_id: groupId,
        system_unit_id,
        job_name: 'importMovBySalesCons',
        parameters: JSON.stringify({ data: dataRef })
      });

      log(`✅ Unidade ${system_unit_id} processada com sucesso`, 'workerCreateDocSaida');

    } catch (err) {
      log(`❌ Erro inesperado ao processar unidade ${system_unit_id}: ${err.message}`, 'workerCreateDocSaida');
    }
  }
}

module.exports = { processDocSaida };

if (require.main === module) {
  const group_id = process.env.GROUP_ID;
  const data = DateTime.now().minus({ days: 1 }).toISODate();
  processDocSaida({ group_id, data });
}
