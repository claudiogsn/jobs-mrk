require('dotenv').config();
const { log } = require('../utils/logger');
const { callPHP } = require('../utils/utils');
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
      const inicio = Date.now();
      const result = await callPHP('importMovBySalesCons', { system_unit_id, data: dataRef });

      const sucesso = result?.success === true || result?.status === 'success';

      if (!sucesso) {
        log(`❌ Falha ao importar movimentação para unidade ${system_unit_id}: ${result.message}`, 'workerCreateDocSaida');
        continue;
      }
      const final = Date.now();
      await callPHP('registerJobExecution', {
        nome_job: 'baixa-estoque-js',
        system_unit_id: system_unit_id,
        custom_code: unidade.custom_code,
        inicio: DateTime.fromMillis(inicio).toFormat('yyyy-MM-dd HH:mm:ss'),
        final: DateTime.fromMillis(final).toFormat('yyyy-MM-dd HH:mm:ss')
      });

      log(`✅ Unidade ${system_unit_id} processada com sucesso`, 'workerCreateDocSaida');

    } catch (err) {
      log(`❌ Erro inesperado ao processar unidade ${system_unit_id}: ${err.message}`, 'workerCreateDocSaida');
    }
  }
}

async function ExecuteJobDocSaida() {
  const hoje = DateTime.local();
  const day = hoje.minus({ days: 1 });

  log(`⏱️ Iniciando processDocSaida de ${day} às ${hoje.toFormat('HH:mm:ss')}`, 'workerCreateDocSaida');


  const grupos = await callPHP('getGroupsToProcess', {});

  if (!Array.isArray(grupos) || grupos.length === 0) {
    log('⚠️ Nenhum grupo encontrado para processar.', 'workerCreateDocSaida');
    return;
  }

  for (const grupo of grupos) {
    const group_id = grupo.id;
    const nomeGrupo = grupo.nome;
    log(`🚀 Processando grupo: ${nomeGrupo} (ID: ${group_id})`, 'workerCreateDocSaida');
    await processDocSaida({ group_id, day });
    }


    log(`⏱️ Finalizando processDocSaida de ${day} às ${hoje.toFormat('HH:mm:ss')}`, 'workerCreateDocSaida');
}

module.exports = { processDocSaida, ExecuteJobDocSaida };

if (require.main === module) {
    ExecuteJobDocSaida();
}
