// Leitura no banco para o MrkSync: a réplica do PDV de uma loja num período (tabelas integracao_menew_*, uma linha
// do Firebird em `dados`) e o que a API do Menew gravou no mesmo período. Só faz SELECT.
//
// Com a migration 000035 do mrk-core, as tabelas têm colunas geradas com índice (replica_dt_mov,
// replica_num_controle, replica_numero_nfc). Sem elas, cai no filtro pelo JSON, que varre as linhas da loja.

const parse = (v) => (typeof v === 'string' ? JSON.parse(v) : v);

async function linhas(conn, tabela, unitId, filtro = '', params = []) {
    const [rows] = await conn.query(
        `SELECT dados FROM integracao_menew_${tabela} WHERE system_unit_id = ? ${filtro ? `AND ${filtro}` : ''}`,
        [unitId, ...params]
    );
    return rows.map((r) => parse(r.dados));
}

/** Lojas com máquina do MrkSync ativa (não revogada) que já mandou réplica. */
async function unidadesComMrkSync(conn) {
    const [rows] = await conn.query(`
        SELECT su.id, su.name AS nome, su.custom_code, MAX(m.ultima_replica_em) AS ultima_replica_em
        FROM agentes_maquinas m
        JOIN system_unit su ON su.id = m.system_unit_id
        WHERE m.revogado_em IS NULL AND m.ultima_replica_em IS NOT NULL
          AND su.custom_code IS NOT NULL AND su.custom_code <> ''
        GROUP BY su.id, su.name, su.custom_code
        ORDER BY su.name`);
    return rows;
}

async function unidade(conn, unitId) {
    const [rows] = await conn.query('SELECT id, name AS nome, custom_code FROM system_unit WHERE id = ?', [unitId]);
    return rows[0] || null;
}

let comIndice = null;
/** A migration 000035 (colunas geradas com índice) já está no banco? */
async function temIndice(conn) {
    if (comIndice !== null) return comIndice;
    const [rows] = await conn.query(
        `SELECT COUNT(*) AS n FROM information_schema.COLUMNS
         WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'integracao_menew_tbnfce_itens' AND COLUMN_NAME = 'replica_numero_nfc'`
    );
    comIndice = Number(rows[0].n) > 0;
    return comIndice;
}

/** Linhas cuja coluna está numa lista, em lotes (IN com muitos valores). */
async function linhasEm(conn, tabela, unitId, coluna, valores) {
    const out = [];
    for (let i = 0; i < valores.length; i += 500) {
        const lote = valores.slice(i, i + 500);
        out.push(...(await linhas(conn, tabela, unitId, `${coluna} IN (${lote.map(() => '?').join(',')})`, lote)));
    }
    return out;
}

/** Réplica de [inicio, fim] (AAAA-MM-DD), no formato que montarVendas espera. */
async function lerReplica(conn, unitId, inicio, fim) {
    const indice = await temIndice(conn);
    const porDtMov = indice ? 'replica_dt_mov BETWEEN ? AND ?' : "dados->>'$.DT_MOV' BETWEEN ? AND ?";
    const faixa = indice ? [inicio, fim] : [inicio, `${fim}T23:59:59`];
    // Em série: em paralelo, várias leituras grandes ao mesmo tempo pesam no RDS.
    const contas = await linhas(conn, 'tbcabconta', unitId, porDtMov, faixa);
    const itens = await linhas(conn, 'tbdetconta', unitId, porDtMov, faixa);
    const pagamentos = await linhas(conn, 'tbpagconta', unitId, porDtMov, faixa);

    const contasSet = new Set(contas.map((c) => Number(c.NUM_CONTROLE)));
    let notas;
    if (indice) {
        notas = await linhasEm(conn, 'tbnfce', unitId, 'replica_num_controle', [...contasSet].map(String));
    } else {
        // A nota pode sair no dia seguinte ao movimento (conta fechada depois da meia-noite).
        notas = (await linhas(conn, 'tbnfce', unitId, "dados->>'$.DATA_EMISSAO' BETWEEN ? AND ?", [
            diaMais(inicio, -1),
            `${diaMais(fim, 2)}T23:59:59`,
        ])).filter((n) => contasSet.has(Number(n.NUM_CONTROLE)));
    }

    let itensNota = [];
    if (notas.length) {
        const numeros = [...new Set(notas.map((n) => Number(n.NUMERO_NFC)))];
        const set = new Set(numeros);
        if (indice) {
            itensNota = await linhasEm(conn, 'tbnfce_itens', unitId, 'replica_numero_nfc', numeros.map(String));
        } else {
            const min = Math.min(...numeros), max = Math.max(...numeros);
            itensNota = await linhas(conn, 'tbnfce_itens', unitId, "CAST(dados->>'$.NUMERO_NFC' AS UNSIGNED) BETWEEN ? AND ?", [min, max]);
        }
        itensNota = itensNota.filter((i) => set.has(Number(i.NUMERO_NFC)));
    }

    const operadores = await linhas(conn, 'tbope', unitId);
    const produtos = await linhas(conn, 'tbprod', unitId);
    const categorias = await linhas(conn, 'tbcateg', unitId);
    const formas = await linhas(conn, 'tbforma', unitId);
    const [meios] = await conn.query('SELECT id_externo, codigo, nome, taxa_comissao FROM meios_pagamento WHERE system_unit_id = ?', [unitId]);

    return { contas, itens, pagamentos, notas, itensNota, operadores, produtos, categorias, formas, meios };
}

/** O que a API do Menew gravou em [inicio, fim] para a loja. */
async function lerApi(conn, un, inicio, fim) {
    const [caixa] = await conn.query(
        `SELECT * FROM movimento_caixa WHERE lojaId = ? AND dataContabil BETWEEN ? AND ?`,
        [String(un.custom_code), inicio, fim]
    );
    const [vendas] = await conn.query(
        `SELECT * FROM sales WHERE system_unit_id = ? AND dtLancamento BETWEEN ? AND ?`,
        [un.id, `${inicio} 00:00:00`, `${fim} 23:59:59`]
    );
    const [pagamentos] = await conn.query(
        `SELECT * FROM api_pagamentos WHERE system_unit_id = ? AND data_contabil BETWEEN ? AND ?`,
        [un.id, inicio, fim]
    );
    return { caixa, vendas, pagamentos };
}

function diaMais(dia, n) {
    const d = new Date(`${dia}T12:00:00Z`);
    d.setUTCDate(d.getUTCDate() + n);
    return d.toISOString().slice(0, 10);
}

module.exports = { unidadesComMrkSync, unidade, lerReplica, lerApi, diaMais };
