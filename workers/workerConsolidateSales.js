require('dotenv').config();
const { log } = require('../utils/logger');
const { DateTime } = require('luxon');
const { callPHP } = require('../utils/apiLogger');

const groupId = process.env.GROUP_ID || '1';
const startDate = DateTime.now().minus({ days: 1 }).toISODate();
const endDate = startDate;

async function processConsolidation() {
  const inicio = Date.now();

  log(`🔄 Iniciando consolidação para grupo ${groupId}`, 'workerConsolidation');

  const response = await callPHP('consolidateSalesByGroup', {
    group_id: groupId,
    dt_inicio: startDate,
    dt_fim: endDate
  });

  const sucesso = response?.success === true || response?.status === 'success';

  if (!sucesso) {
    log(`❌ Falha na consolidação de vendas`, 'workerConsolidation');
    return;
  }

  const final = Date.now();
  const executionTime = ((final - inicio) / 60000).toFixed(2);

  await callPHP('registerJobExecution', {
    nome_job: 'consolidate-sales-js',
    system_unit_id: groupId,
    custom_code: groupId,
    inicio: DateTime.fromMillis(inicio).toFormat('yyyy-MM-dd HH:mm:ss'),
    final: DateTime.fromMillis(final).toFormat('yyyy-MM-dd HH:mm:ss'),
    execution_time: executionTime
  });

  log(`✅ Consolidação concluída em ${executionTime} minutos`, 'workerConsolidation');
}

async function ExecuteJobConsolidation() {
  const group_id = process.env.GROUP_ID;
  const hoje = DateTime.local();
  const ontem = hoje.minus({ days: 1 });

  const dt_inicio = ontem.toFormat('yyyy-MM-dd');
  const dt_fim = hoje.toFormat('yyyy-MM-dd');

  console.log(`⏱️ Iniciando job de ${dt_inicio} até ${dt_fim} às ${hoje.toFormat('HH:mm:ss')}`);
  await processConsolidation({ group_id, dt_inicio, dt_fim });
  console.log(`✅ Job finalizado às ${DateTime.local().toFormat('HH:mm:ss')}`);
}

module.exports = { processConsolidation, ExecuteJobConsolidation };

if (require.main === module) {
    ExecuteJobConsolidation();
}