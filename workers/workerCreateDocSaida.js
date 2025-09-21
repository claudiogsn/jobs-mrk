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

// Luxon DateTime
async function ExecuteJobDocSaida(dt_inicio, dt_fim, group_id) {
  // Defaults: ontem -> hoje
  const hoje  = DateTime.now().toISODate();
  const ontem = DateTime.now().minus({ days: 1 }).toISODate();

  if (!dt_inicio || !dt_fim) {
    dt_inicio = dt_inicio || ontem;
    dt_fim    = dt_fim    || hoje;
  }

  let start = DateTime.fromISO(dt_inicio);
  let end   = DateTime.fromISO(dt_fim);
  if (end < start) [start, end] = [end, start]; // normaliza intervalo invertido

  // Resolve grupos
  const grupos = group_id
      ? [{ id: Number(group_id) }]
      : await callPHP('getGroupsToProcess', {});

  if (!Array.isArray(grupos) || grupos.length === 0) {
    log('⚠️ Nenhum grupo encontrado para processar.', 'workerCreateDocSaida');
    return;
  }

  for (const g of grupos) {
    const gid = g.id ?? g; // tolera {id} ou número puro

    log(`Start: ${start.toISODate()} - End: ${end.toISODate()}`);
    log(`⏱️ Início do processamento às ${DateTime.local().toFormat('HH:mm:ss')}`, 'workerCreateDocSaida');

    for (let cursor = start; cursor <= end; cursor = cursor.plus({ days: 1 })) {
      const data = cursor.toFormat('yyyy-MM-dd');
      await processDocSaida({ group_id: gid, day: data });
      log(`✅ Dia ${data} processado para o grupo ${gid}`, 'workerCreateDocSaida');
    }

    log(`✅ Grupo ${gid} finalizado às ${DateTime.local().toFormat('HH:mm:ss')}`, 'workerCreateDocSaida');
  }
}


module.exports = { processDocSaida, ExecuteJobDocSaida };

if (require.main === module) {
    ExecuteJobDocSaida();
}
