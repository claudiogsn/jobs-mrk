require('dotenv').config();

const { log } = require('../utils/logger');
const { DateTime } = require('luxon');
const { callPHP, callMenew, loginMenew } = require('../utils/utils');
const { processJobCaixaZig } = require('./workerBillingZig');

// 1. NOVO: Importando o worker de pagamentos que você criou!
const { WorkerJobConferencia } = require('./workerPagamentos');

function extrairNumControle(operacaoId) {
    if (!operacaoId || typeof operacaoId !== 'string') return null;
    const partes = operacaoId.split('.');
    return partes.length === 3 ? partes[2] : null;
}

const ajustarHorarioMenew = (str, tipo = 'datetime') => {
    if (!str) return null;
    const clean = str.replace(/ [-+]\d{4}$/, ''); // remove o " -0300"
    return tipo === 'date' ? clean.substring(0, 10) : clean;
};

function adicionarSufixoSequencial(meios) {
    return meios.map((mp, index) => {
        const novoId = `${mp.id}${index + 1}`;
        return { ...mp, id: novoId };
    });
}

async function processMovimentoCaixa({ group_id, dt_inicio, dt_fim } = {}) {
    const groupId = parseInt(group_id);
    const dataInicio = DateTime.fromISO(dt_inicio ?? DateTime.local().minus({ days: 1 }).toISODate());
    const dataFim = DateTime.fromISO(dt_fim ?? dataInicio.toISODate());

    const unidades = await callPHP('getUnitsIntegrationMenewBilling', { group_id: groupId });

    if (!Array.isArray(unidades) || unidades.length === 0) {
        log('⚠️ Nenhuma unidade encontrada.', 'workerMovimentoCaixa');
        await processJobCaixaZig(group_id, dt_inicio, dt_fim);
        return;
    }

    const authToken = await loginMenew();
    if (!authToken) {
        log('❌ Falha ao autenticar na Menew.', 'workerMovimentoCaixa');
        await processJobCaixaZig(group_id, dt_inicio, dt_fim);
        return;
    }

    // Quebrar intervalo de 10 em 10 dias
    let blocoInicio = dataInicio;
    while (blocoInicio <= dataFim) {
        const blocoFim = DateTime.min(blocoInicio.plus({ days: 9 }), dataFim);
        const dtinicio = blocoInicio.toFormat('yyyy-MM-dd');
        const dtfim = blocoFim.toFormat('yyyy-MM-dd');

        log(`📆 Processando período de ${dtinicio} até ${dtfim}`, 'workerMovimentoCaixa');

        for (const unidade of unidades) {
            // 2. NOVO: try/catch DENTRO do loop. Se uma loja quebrar, a próxima continua!
            try {
                const customCode = unidade.lojaId;
                const systemUnitId = unidade.system_unit_id;
                const nomeLoja = unidade.name || 'Desconhecida';

                if (!customCode || !systemUnitId) {
                    log(`⚠️ [Loja Ignorada] Dados inválidos: ${JSON.stringify(unidade)}`, 'workerMovimentoCaixa');
                    continue;
                }

                const inicio = Date.now();
                log(`🔄 [Loja ${customCode} - ${nomeLoja}] Iniciando busca de movimentos...`, 'workerMovimentoCaixa');

                const payload = {
                    token: authToken,
                    requests: {
                        jsonrpc: '2.0',
                        method: 'movimentocaixa',
                        params: {
                            lojas: customCode,
                            dtinicio,
                            dtfim
                        },
                        id: '1'
                    }
                };

                const response = await callMenew(payload, authToken);
                const movimentos = response?.result;

                if (!Array.isArray(movimentos) || movimentos.length === 0) {
                    log(`⚠️ [Loja ${customCode} - ${nomeLoja}] Nenhum movimento encontrado neste período.`, 'workerMovimentoCaixa');
                    continue;
                }

                log(`📡 [Loja ${customCode} - ${nomeLoja}] ${movimentos.length} movimentos encontrados na Menew. Mapeando dados...`, 'workerMovimentoCaixa');

                const movimentoData = movimentos.map(mov => ({
                    id: mov.idMovimentoCaixa,
                    num_controle: extrairNumControle(mov.operacaoId),
                    redeId: mov.redeId,
                    rede: mov.rede,
                    lojaId: mov.lojaId,
                    loja: mov.loja,
                    modoVenda: mov.modoVenda,
                    idModoVenda: mov.idModoVenda,
                    hora: mov.hora,
                    idAtendente: mov.idAtendente,
                    codAtendente: mov.codAtendente,
                    nomeAtendente: mov.nomeAtendente,
                    vlDesconto: mov.vlDesconto,
                    vlAcrescimo: mov.vlAcrescimo,
                    vlTotalReceber: mov.vlTotalReceber,
                    vlTotalRecebido: mov.vlTotalRecebido,
                    vlServicoRecebido: mov.vlServicoRecebido,
                    vlTrocoFormasPagto: mov.vlTrocoFormasPagto,
                    vlRepique: mov.vlRepique,
                    vlTaxaEntrega: mov.vlTaxaEntrega,
                    numPessoas: mov.numPessoas,
                    operacaoId: mov.operacaoId,
                    maquinaId: mov.maquinaId,
                    nomeMaquina: mov.nomeMaquina,
                    maquinaCod: mov.maquinaCod,
                    maquinaPortaFiscal: mov.maquinaPortaFiscal,
                    periodoId: mov.periodoId,
                    periodoCod: mov.periodoCod,
                    periodoNome: mov.periodoNome,
                    cancelado: typeof mov.cancelado === 'boolean'
                        ? mov.cancelado ? 1 : 0
                        : (mov.cancelado === 1 ? 1 : 0),
                    modoVenda2: mov.modoVenda2,
                    dataAbertura: ajustarHorarioMenew(mov.dataAbertura),
                    dataFechamento: ajustarHorarioMenew(mov.dataFechamento),
                    dataContabil: ajustarHorarioMenew(mov.dataContabil, 'date'),
                    meiosPagamento: mov.meiosPagamento
                        ? adicionarSufixoSequencial(mov.meiosPagamento)
                        : [],
                    consumidores: mov.consumidores
                }));

                log(`💾 [Loja ${customCode} - ${nomeLoja}] Persistindo no backend PHP...`, 'workerMovimentoCaixa');
                await callPHP('persistMovimentoCaixa', movimentoData);

                const safeDate = (ts) => {
                    const dt = DateTime.fromMillis(ts);
                    return dt.isValid ? dt.toFormat('yyyy-MM-dd HH:mm:ss') : null;
                };

                const final = Date.now();
                await callPHP('registerJobExecution', {
                    nome_job: 'movimento-caixa-js',
                    system_unit_id: systemUnitId,
                    custom_code: customCode,
                    inicio: safeDate(inicio),
                    final: safeDate(Date.now())
                });

                const tempoExec = ((final - inicio) / 60000).toFixed(2);
                log(`✅ [Loja ${customCode} - ${nomeLoja}] Processada com sucesso em ${tempoExec} min`, 'workerMovimentoCaixa');

            } catch (erroUnidade) {
                // Se der erro de parsing ou timeout em UMA loja, ele cai aqui, loga o erro, e vai pra próxima!
                log(`❌ [Loja ${unidade.lojaId}] Falha ao processar unidade: ${erroUnidade.message}`, 'workerMovimentoCaixa');
            }
        }

        blocoInicio = blocoFim.plus({ days: 1 });
    }

    // 3. NOVO: Chamando a atualização de pagamentos antes da Zig
    log(`🚀 Chamando Job de Conferência (Pagamentos) para o Grupo ${groupId || 'ALL'}...`, 'workerMovimentoCaixa');
    try {
        await WorkerJobConferencia(dt_inicio, dt_fim, group_id);
        log(`✅ Job de Conferência concluído.`, 'workerMovimentoCaixa');
    } catch (e) {
        log(`❌ Erro ao executar WorkerJobConferencia: ${e.message}`, 'workerMovimentoCaixa');
    }

    log(`🚀 Chamando Job Caixa Zig para o Grupo ${groupId || 'ALL'}...`, 'workerMovimentoCaixa');
    try {
        await processJobCaixaZig(group_id, dt_inicio, dt_fim);
        log(`✅ Job Caixa Zig concluído.`, 'workerMovimentoCaixa');
    } catch (e) {
        log(`❌ Erro ao executar processJobCaixaZig: ${e.message}`, 'workerMovimentoCaixa');
    }
}

async function ExecuteJobCaixa(dt_inicio, dt_fim, group_id) {
    const hoje = DateTime.local();
    const ontem = hoje.minus({ days: 1 });

    dt_inicio = dt_inicio || ontem.toFormat('yyyy-MM-dd');
    dt_fim    = dt_fim    || hoje.toFormat('yyyy-MM-dd');

    log(`⏱️ Iniciando job de ${dt_inicio} até ${dt_fim} às ${hoje.toFormat('HH:mm:ss')}`, 'workerMovimentoCaixa');

    const grupos = group_id
        ? [{ id: Number(group_id), nome: `Grupo ${group_id}` }]
        : await callPHP('getGroupsToProcess', {});

    if (!Array.isArray(grupos) || grupos.length === 0) {
        log('⚠️ Nenhum grupo encontrado para processar.', 'workerMovimentoCaixa');
        return;
    }

    for (const grupo of grupos) {
        const gid = grupo.id ?? grupo;
        const nomeGrupo = grupo.nome || `Grupo ${gid}`;
        log(`🚀 Processando grupo: ${nomeGrupo} (ID: ${gid})`, 'workerMovimentoCaixa');
        await processMovimentoCaixa({ group_id: gid, dt_inicio, dt_fim });
    }

    log(`🏁 Job finalizado às ${hoje.toFormat('HH:mm:ss')}`, 'workerMovimentoCaixa');
}

module.exports = { processMovimentoCaixa, ExecuteJobCaixa };

if (require.main === module) {
    ExecuteJobCaixa();
}