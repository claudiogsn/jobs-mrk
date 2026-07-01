require('dotenv').config();

const { log } = require('../utils/logger');
const { getLogger } = require('@mrksolucoes/observability');
const { DateTime } = require('luxon');
const { callMenew, loginMenew, callPHP} = require('../utils/utils');
const mysql = require('mysql2/promise');
const crypto = require('crypto');
const uuidv4 = () => crypto.randomUUID();

// Configuração de Lote para Insert
const CHUNK_SIZE = 500;

// ==========================================
// FUNÇÕES AUXILIARES
// ==========================================

function chunkArray(array, size) {
    const result = [];
    for (let i = 0; i < array.length; i += size) {
        result.push(array.slice(i, i + size));
    }
    return result;
}

const ajustarData = (str) => {
    if (!str) return null;
    const clean = str.replace(/ [-+]\d{4}$/, '');
    return clean.substring(0, 10); // YYYY-MM-DD
};

const ajustarDateTime = (str) => {
    if (!str) return null;
    return str.replace(/ [-+]\d{4}$/, '');
};

// ==========================================
// CHAMADAS DE API ESPECÍFICAS
// ==========================================

async function buscarMeiosPagamentoAPI(lojaId, token) {
    const url = `https://batech.portalmenew.com.br/terceiros/restful/meios-pagamento?lojas=${lojaId}&ativo=1&Authorization=${token}`;
    // Não logar a URL crua (contém o token na query string).
    log(`🔎 Buscando meios de pagamento da loja ${lojaId}`, 'workerPagamentos');

    const response = await fetch(url);
    if (!response.ok) {
        throw new Error(`Erro na API (Meios Pagamento): Status ${response.status}`);
    }
    return await response.json();
}

// ==========================================
// LÓGICA DE PERSISTÊNCIA
// ==========================================

async function salvarMeiosPagamento(conn, dados, systemUnitId) {
    if (!dados || dados.length === 0) return;

    // Prepara os dados para o bulk insert
    const rows = dados.map(m => [
        systemUnitId,
        m.id,
        m.codigo,
        m.nome,
        m.taxaComissao || 0,
        m.redeId || null,
        m.lojaId,
        m.ativo ? 1 : 0
    ]);

    // O uso do ON DUPLICATE KEY UPDATE garante que se o id_externo + system_unit_id
    // já existirem, ele apenas atualiza os dados, sem duplicar.
    const sql = `
        INSERT INTO meios_pagamento (
            system_unit_id, id_externo, codigo, nome, taxa_comissao, rede_id, loja_id, ativo
        ) VALUES ?
        ON DUPLICATE KEY UPDATE
            codigo = VALUES(codigo),
            nome = VALUES(nome),
            taxa_comissao = VALUES(taxa_comissao),
            rede_id = VALUES(rede_id),
            loja_id = VALUES(loja_id),
            ativo = VALUES(ativo)
    `;

    const chunks = chunkArray(rows, CHUNK_SIZE);
    for (const chunk of chunks) {
        await conn.query(sql, [chunk]);
    }
}

async function salvarMovimentoCaixa(conn, dados, lojaId, dtInicio, dtFim) {
    if (!dados || dados.length === 0) return;

    await conn.execute(`
        DELETE FROM api_movimento_caixa 
        WHERE loja_id = ? AND data_contabil BETWEEN ? AND ?
    `, [lojaId, dtInicio, dtFim]);

    const pais = [];
    const filhos = [];

    for (const mov of dados) {
        const parentUUID = uuidv4();

        pais.push([
            parentUUID, mov.idMovimentoCaixa, mov.lojaId, mov.loja, mov.modoVenda, mov.idModoVenda,
            mov.hora, mov.idAtendente, mov.nomeAtendente, mov.vlDesconto, mov.vlAcrescimo,
            mov.vlTotalReceber, mov.vlTotalRecebido, mov.vlServicoRecebido, mov.vlTrocoFormasPagto,
            mov.numPessoas, mov.operacaoId, mov.maquinaId, mov.nomeMaquina, mov.periodoId,
            mov.periodoNome, mov.cancelado ? 1 : 0, ajustarDateTime(mov.dataAbertura),
            ajustarDateTime(mov.dataFechamento), ajustarData(mov.dataContabil)
        ]);

        if (mov.meiosPagamento && Array.isArray(mov.meiosPagamento)) {
            for (const mp of mov.meiosPagamento) {
                filhos.push([
                    uuidv4(), parentUUID, mp.id, mp.codigo, mp.nome, mp.valor, mp.troco, mp.valorRecebido
                ]);
            }
        }
    }

    if (pais.length > 0) {
        const sqlPai = `INSERT INTO api_movimento_caixa (
            uuid, id_movimento_caixa, loja_id, loja_nome, modo_venda, id_modo_venda, hora, 
            id_atendente, nome_atendente, vl_desconto, vl_acrescimo, vl_total_receber, 
            vl_total_recebido, vl_servico_recebido, vl_troco, num_pessoas, operacao_id, 
            maquina_id, nome_maquina, periodo_id, periodo_nome, cancelado, 
            data_abertura, data_fechamento, data_contabil
        ) VALUES ?`;

        const chunksPai = chunkArray(pais, CHUNK_SIZE);
        for (const chunk of chunksPai) await conn.query(sqlPai, [chunk]);
    }

    if (filhos.length > 0) {
        const sqlFilho = `INSERT INTO api_movimento_caixa_pagamentos (
            uuid, movimento_caixa_uuid, id_pagamento_json, codigo_meio, nome_meio, 
            valor, troco, valor_recebido
        ) VALUES ?`;

        const chunksFilho = chunkArray(filhos, CHUNK_SIZE);
        for (const chunk of chunksFilho) await conn.query(sqlFilho, [chunk]);
    }
}

async function salvarPagamentos(conn, dados, lojaId, dtInicio, dtFim) {
    if (!dados || dados.length === 0) return;

    await conn.execute(`
        DELETE FROM api_pagamentos
        WHERE id_loja = ? AND data_contabil BETWEEN ? AND ?
    `, [lojaId, dtInicio, dtFim]);

    const rows = dados.map(pg => [
        uuidv4(), pg.idOperacao, pg.idLoja, pg.nomeLoja, pg.numPedido, pg.seqPedido,
        ajustarData(pg.dataContabil), pg.status, ajustarData(pg.dataLancamento),
        pg.horaLancamento, pg.idM, pg.descricao, ajustarData(pg.dataVencimento),
        pg.diasVencimento, pg.valor, pg.taxaComissao, pg.valorComissao,
        pg.valorLiquido, pg.parcela, pg.nsu, pg.origem, pg.adquirente,
        pg.autorizacao, pg.idTipo, pg.tipoPagamento, pg.idBandeira, pg.bandeira, pg.cnpjAdquirente
    ]);

    const sql = `INSERT INTO api_pagamentos (
        uuid, id_operacao, id_loja, nome_loja, num_pedido, seq_pedido, data_contabil,
        status_pagamento, data_lancamento, hora_lancamento, id_m, descricao,
        data_vencimento, dias_vencimento, valor, taxa_comissao, valor_comissao,
        valor_liquido, parcela, nsu, origem, adquirente,
        autorizacao, id_tipo, tipo_pagamento, id_bandeira, bandeira, cnpj_adquirente
    ) VALUES ?`;

    const chunks = chunkArray(rows, CHUNK_SIZE);
    for (const chunk of chunks) await conn.query(sql, [chunk]);
}

async function salvarFechamentoCaixa(conn, dados, lojaId, dtInicio, dtFim) {
    if (!dados || dados.length === 0) return;

    await conn.execute(`
        DELETE FROM api_fechamento_caixa
        WHERE id_estabelecimento = ? AND STR_TO_DATE(movimento, '%d/%m/%Y') BETWEEN ? AND ?
    `, [lojaId, dtInicio, dtFim]);

    const pais = [];
    const cartoes = [];
    const outros = [];

    for (const fech of dados) {
        const parentUUID = uuidv4();

        pais.push([
            parentUUID, fech.idestabelecimento, fech.nome_estabelecimento, fech.movimento, fech.turno,
            fech.data_hora_abertura, fech.data_hora_fechamento, fech.operador, fech.dinheiro_computado,
            fech.cartao_computado, fech.dinheiro_digitado, fech.cartao_digitado, fech.troco_inicial,
            fech.troco_final, fech.diferenca_dinheiro, fech.diferenca_cartao
        ]);

        if (fech.cartao_detalhado) {
            for (const c of fech.cartao_detalhado) {
                cartoes.push([uuidv4(), parentUUID, c.descricao, c.vl_sistema, c.vl_digitado]);
            }
        }

        if (fech.outros_pagamentos) {
            for (const o of fech.outros_pagamentos) {
                outros.push([uuidv4(), parentUUID, o.forma_pag, o.descricao, o.valor]);
            }
        }
    }

    if (pais.length > 0) {
        const sqlPai = `INSERT INTO api_fechamento_caixa (
            uuid, id_estabelecimento, nome_estabelecimento, movimento, turno,
            data_hora_abertura, data_hora_fechamento, operador_id, dinheiro_computado,
            cartao_computado, dinheiro_digitado, cartao_digitado, troco_inicial,
            troco_final, diferenca_dinheiro, diferenca_cartao
        ) VALUES ?`;
        const chunks = chunkArray(pais, CHUNK_SIZE);
        for (const chunk of chunks) await conn.query(sqlPai, [chunk]);
    }

    if (cartoes.length > 0) {
        const sqlCartoes = `INSERT INTO api_fechamento_cartoes (
            uuid, fechamento_uuid, descricao, vl_sistema, vl_digitado
        ) VALUES ?`;
        const chunks = chunkArray(cartoes, CHUNK_SIZE);
        for (const chunk of chunks) await conn.query(sqlCartoes, [chunk]);
    }

    if (outros.length > 0) {
        const sqlOutros = `INSERT INTO api_fechamento_outros (
            uuid, fechamento_uuid, forma_pag_id, descricao, valor
        ) VALUES ?`;
        const chunks = chunkArray(outros, CHUNK_SIZE);
        for (const chunk of chunks) await conn.query(sqlOutros, [chunk]);
    }
}

// ==========================================
// WORKER PRINCIPAL
// ==========================================

async function ExecuteJobConferencia({ group_id, data } = {}) {
    const groupId = parseInt(group_id);
    const hoje = DateTime.local();

    const dataAlvo = DateTime.fromISO(data ?? hoje.minus({ days: 1 }).toISODate());
    const dtFormatada = dataAlvo.toFormat('yyyy-MM-dd');

    log(`🚀 Iniciando Worker Conferencia | Grupo: ${groupId || 'ALL'} | Data: ${dtFormatada}`, 'workerConferencia');

    const dbConfig = {
        host: process.env.DB_HOST,
        user: process.env.DB_USER,
        password: process.env.DB_PASS,
        database: process.env.DB_NAME,
        dateStrings: true
    };

    log(`🔌 Conectando ao banco (${dbConfig.host}/${dbConfig.database}) | senha: ${dbConfig.password ? 'definida' : 'UNDEFINED (VERIFIQUE O .ENV)'}`, 'workerConferencia');

    let conn;
    try {
        conn = await mysql.createConnection(dbConfig);
        log(`✅ Conexão bem sucedida! Thread ID: ${conn.threadId}`, 'workerConferencia');
    } catch (e) {
        getLogger().error(e, { contexto: 'conectar ao banco (workerConferencia)' });
        throw e;
    }

    try {
        let unidades = [];
        if (groupId) {
            const [rows] = await conn.execute(`
                SELECT su.id AS system_unit_id, su.custom_code, su.name
                FROM system_unit AS su
                         JOIN grupo_estabelecimento_rel AS rel ON rel.system_unit_id = su.id
                WHERE rel.grupo_id = ? AND su.custom_code IS NOT NULL
            `, [groupId]);
            unidades = rows;
        } else {
            const [rows] = await conn.execute(`SELECT id AS system_unit_id, custom_code, name FROM system_unit WHERE custom_code IS NOT NULL`);
            unidades = rows;
        }

        if (unidades.length === 0) {
            log('⚠️ Nenhuma unidade encontrada.', 'workerConferencia');
            return;
        }

        const authToken = await loginMenew();
        if (!authToken) {
            throw new Error('Falha no login da API Menew');
        }

        log(`📅 Processando Data: ${dtFormatada}`, 'workerConferencia');

        for (const unidade of unidades) {
            const lojaId = unidade.custom_code;
            const systemUnitId = unidade.system_unit_id; // Pega o ID interno retornado pelo select
            log(`🏢 Loja: ${unidade.name} (${lojaId})`, 'workerConferencia');

            // --- NOVO: CHAMADA 0: ATUALIZAR MEIOS DE PAGAMENTO ---
            try {
                const respMeios = await buscarMeiosPagamentoAPI(lojaId, authToken);

                if (respMeios && respMeios.length > 0) {
                    await salvarMeiosPagamento(conn, respMeios, systemUnitId);
                    log(`  ✅ Meios Pagamento: ${respMeios.length} atualizados`, 'workerConferencia');
                } else {
                    log(`  ℹ️ Meios Pagamento: Sem dados`, 'workerConferencia');
                }
            } catch (e) {
                log(`  ❌ Erro Meios Pagamento: ${e.message}`, 'workerConferencia');
            }

            // --- CHAMADA 1: MOVIMENTO CAIXA ---
            try {
                const respMov = await callMenew({
                    token: authToken,
                    requests: { jsonrpc: '2.0', method: 'movimentocaixa', params: { lojas: lojaId, dtinicio: dtFormatada, dtfim: dtFormatada }, id: '1' }
                }, authToken);

                if (respMov?.result?.length) {
                    await salvarMovimentoCaixa(conn, respMov.result, lojaId, dtFormatada, dtFormatada);
                    log(`  ✅ Movimento Caixa: ${respMov.result.length} registros`, 'workerConferencia');
                } else {
                    log(`  ℹ️ Movimento Caixa: Sem dados`, 'workerConferencia');
                }
            } catch (e) {
                log(`  ❌ Erro Movimento Caixa: ${e.message}`, 'workerConferencia');
            }

            // --- CHAMADA 2: PAGAMENTOS ---
            try {
                const respPag = await callMenew({
                    token: authToken,
                    requests: { jsonrpc: '2.0', method: 'pagamentos', params: { lojas: lojaId, dtinicio: dtFormatada, dtfim: dtFormatada }, id: '1' }
                }, authToken);

                if (respPag?.result?.length) {
                    await salvarPagamentos(conn, respPag.result, lojaId, dtFormatada, dtFormatada);
                    log(`  ✅ Pagamentos: ${respPag.result.length} registros`, 'workerConferencia');
                } else {
                    log(`  ℹ️ Pagamentos: Sem dados`, 'workerConferencia');
                }
            } catch (e) {
                log(`  ❌ Erro Pagamentos: ${e.message}`, 'workerConferencia');
            }

            // --- CHAMADA 3: FECHAMENTO CAIXA ---
            try {
                const respFech = await callMenew({
                    token: authToken,
                    requests: { jsonrpc: '2.0', method: 'fechamentocaixa', params: { lojas: lojaId, dtinicio: dtFormatada, dtfim: dtFormatada }, id: '1' }
                }, authToken);

                if (respFech?.result?.length) {
                    await salvarFechamentoCaixa(conn, respFech.result, lojaId, dtFormatada, dtFormatada);
                    log(`  ✅ Fechamento Caixa: ${respFech.result.length} registros`, 'workerConferencia');
                } else {
                    log(`  ℹ️ Fechamento Caixa: Sem dados`, 'workerConferencia');
                }
            } catch (e) {
                log(`  ❌ Erro Fechamento Caixa: ${e.message}`, 'workerConferencia');
            }
        }

    } catch (err) {
        log(`🔥 Erro Fatal no Worker: ${err.message}`, 'workerConferencia');
    } finally {
        if (conn) {
            await conn.end();
            log(`🏁 Conexão fechada.`, 'workerConferencia');
        }
    }
}

async function WorkerJobConferencia(dt_inicio, dt_fim, group_id) {
    const hoje  = DateTime.now().toISODate();
    const ontem = DateTime.now().minus({ days: 1 }).toISODate();

    if (!dt_inicio || !dt_fim) {
        dt_inicio = dt_inicio || ontem;
        dt_fim    = dt_fim    || hoje;
    }

    let start = DateTime.fromISO(dt_inicio);
    let end   = DateTime.fromISO(dt_fim);
    if (end < start) [start, end] = [end, start];
    const grupos = group_id
        ? [{ id: Number(group_id) }]
        : await callPHP('getGroupsToProcess', {});

    if (!Array.isArray(grupos) || grupos.length === 0) {
        log('⚠️ Nenhum grupo encontrado para processar.', 'ExecuteJobConferencia');
        return;
    }

    for (const g of grupos) {
        const gid = g.id ?? g;

        log(`Start: ${start.toISODate()} - End: ${end.toISODate()}`);
        log(`⏱️ Início do processamento às ${DateTime.local().toFormat('HH:mm:ss')}`, 'ExecuteJobConferencia');

        for (let cursor = start; cursor <= end; cursor = cursor.plus({ days: 1 })) {
            const data = cursor.toFormat('yyyy-MM-dd');
            await ExecuteJobConferencia({ group_id: gid, data });
            log(`✅ Dia ${data} processado para o grupo ${gid}`, 'ExecuteJobConferencia');
        }

        log(`✅ Grupo ${gid} finalizado às ${DateTime.local().toFormat('HH:mm:ss')}`, 'ExecuteJobConferencia');
    }
}

module.exports = { ExecuteJobConferencia, WorkerJobConferencia };

if (require.main === module) { WorkerJobConferencia() }