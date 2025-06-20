require('dotenv').config();
const { log } = require('../utils/logger');
const { DateTime } = require('luxon');
const axios = require('axios');
const { callPHP, appendApiLog } = require('../utils/apiLogger');

async function callMenew(methodPayload, token) {
    try {
        const res = await axios.post(process.env.MENEW_URL, methodPayload, {
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${token}`
            }
        });
        appendApiLog(`✅ Menew call (${methodPayload?.requests?.method}): sucesso`);
        return res.data;
    } catch (err) {
        appendApiLog(`❌ ERROR (${methodPayload?.requests?.method}): ${JSON.stringify(err.response?.data || err.message)}`);
        return null;
    }
}

async function loginMenew() {
    const payload = {
        token: null,
        requests: {
            jsonrpc: '2.0',
            method: 'Usuario/login',
            params: {
                usuario: 'batech',
                token: 'X7K1g6VJLrcWPM2adw2O'
            },
            id: '1'
        }
    };

    try {
        const response = await axios.post(process.env.MENEW_URL, payload, {
            headers: { 'Content-Type': 'application/json' }
        });

        appendApiLog(`✅ Login Menew: sucesso - token recebido`);
        return response.data?.result || null;
    } catch (err) {
        appendApiLog(`❌ Erro ao fazer login na Menew: ${JSON.stringify(err.response?.data || err.message)}`);
        return null;
    }
}

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
    const groupId = parseInt(group_id ?? process.env.GROUP_ID);
    const dataInicio = DateTime.fromISO(dt_inicio ?? DateTime.local().minus({ days: 1 }).toISODate());
    const dataFim = DateTime.fromISO(dt_fim ?? dataInicio.toISODate());

    const unidades = await callPHP('getUnitsByGroup', { group_id: groupId });

    if (!Array.isArray(unidades) || unidades.length === 0) {
        log('⚠️ Nenhuma unidade encontrada.', 'workerMovimentoCaixa');
        return;
    }

    const authToken = await loginMenew();
    if (!authToken) {
        log('❌ Falha ao autenticar na Menew.', 'workerMovimentoCaixa');
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
            const customCode = unidade.custom_code;
            const systemUnitId = unidade.system_unit_id;

            if (!customCode || !systemUnitId) {
                log(`⚠️ Unidade com dados inválidos: ${JSON.stringify(unidade)}`, 'workerMovimentoCaixa');
                continue;
            }

            const inicio = Date.now();
            log(`🔄 Iniciando processamento para loja: ${customCode}`, 'workerMovimentoCaixa');

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
                log(`⚠️ Nenhum movimento encontrado para loja ${customCode}`, 'workerMovimentoCaixa');
                continue;
            }

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
                meiosPagamento: adicionarSufixoSequencial(mov.meiosPagamento),
                consumidores: mov.consumidores
            }));

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
            log(`✅ Loja ${customCode} processada com sucesso em ${tempoExec} min`, 'workerMovimentoCaixa');
        }

        blocoInicio = blocoFim.plus({ days: 1 });
    }
}

async function ExecuteJobCaixa() {
    const hoje = DateTime.local();
    const ontem = hoje.minus({ days: 1 });

    const dt_inicio = ontem.toFormat('yyyy-MM-dd');
    const dt_fim = hoje.toFormat('yyyy-MM-dd');

    console.log(`⏱️ Iniciando job de ${dt_inicio} até ${dt_fim} às ${hoje.toFormat('HH:mm:ss')}`);

    const grupos = await callPHP('getGroupsToProcess', {});

    if (!Array.isArray(grupos) || grupos.length === 0) {
        console.log('⚠️ Nenhum grupo retornado pela API `getGroupsToProcess`.');
        return;
    }

    for (const grupo of grupos) {
        const group_id = grupo.id;
        const nomeGrupo = grupo.nome;

        console.log(`🚀 Processando grupo: ${nomeGrupo} (ID: ${group_id})`);
        await processMovimentoCaixa({ group_id, dt_inicio, dt_fim });
    }

    console.log(`✅ Job finalizado às ${DateTime.local().toFormat('HH:mm:ss')}`);
}


module.exports = { processMovimentoCaixa, ExecuteJobCaixa };

if (require.main === module) {
    ExecuteJobCaixa();
}
