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

async function ExecuteJobDocSaida(dt_inicio, dt_fim, grupo) {
  const TZ = 'America/Fortaleza';
  const now = DateTime.now().setZone(TZ);

  // Defaults (ontem → hoje)
  const hojeISO  = now.toISODate();
  const ontemISO = now.minus({ days: 1 }).toISODate();

  const startISO = dt_inicio || ontemISO;
  const endISO   = dt_fim    || hojeISO;

  let start = DateTime.fromISO(startISO, { zone: TZ });
  let end   = DateTime.fromISO(endISO,   { zone: TZ });

  if (!start.isValid || !end.isValid) {
    log(`❌ Datas inválidas: dt_inicio='${dt_inicio}', dt_fim='${dt_fim}'`, 'workerCreateDocSaida');
    return;
  }
  if (end < start) [start, end] = [end, start]; // garante início <= fim

  log(
      `⏱️ Iniciando processDocSaida do período ${start.toISODate()} → ${end.toISODate()} às ${now.toFormat('HH:mm:ss')}`,
      'workerCreateDocSaida'
  );


  let grupos = [];

  if (grupo !== undefined && grupo !== null) {
    const ids = Array.isArray(grupo) ? grupo : [grupo];
    grupos = ids.map((id) => ({ id: Number(id), nome: `Grupo ${id}` }));
  } else {
    const fetched = await callPHP('getGroupsToProcess', {});
    if (!Array.isArray(fetched) || fetched.length === 0) {
      log('⚠️ Nenhum grupo encontrado para processar.', 'workerCreateDocSaida');
      return;
    }
    grupos = fetched;
  }

  for (const g of grupos) {
    const group_id  = Number(g?.id ?? g);
    const nomeGrupo = g?.nome || g?.nomeGrupo || `Grupo ${group_id}`;

    log(`🚀 Processando grupo: ${nomeGrupo} (ID: ${group_id})`, 'workerCreateDocSaida');
    log(`Período: ${start.toISODate()} → ${end.toISODate()}`, 'workerCreateDocSaida');
    log(`⏱️ Início do processamento às ${DateTime.now().setZone(TZ).toFormat('HH:mm:ss')}`, 'workerCreateDocSaida');

    for (let cursor = start; cursor <= end; cursor = cursor.plus({ days: 1 })) {

      const day = cursor;
      const dayStr = cursor.toFormat('yyyy-MM-dd');

      try {
        await processDocSaida({ group_id, day });
        log(`✅ Dia ${dayStr} processado para o grupo ${group_id}`, 'workerCreateDocSaida');
      } catch (err) {
        log(`❌ Falha ao processar ${dayStr} para o grupo ${group_id}: ${err?.message || err}`, 'workerCreateDocSaida');
      }
    }

    log(`✅ Grupo ${group_id} finalizado às ${DateTime.now().setZone(TZ).toFormat('HH:mm:ss')}`, 'workerCreateDocSaida');
  }

  log(
      `⏱️ Finalizando processDocSaida do período ${start.toISODate()} → ${end.toISODate()} às ${DateTime.now().setZone(TZ).toFormat('HH:mm:ss')}`,
      'workerCreateDocSaida'
  );
}


module.exports = { processDocSaida, ExecuteJobDocSaida };

if (require.main === module) {
    ExecuteJobDocSaida();
}
