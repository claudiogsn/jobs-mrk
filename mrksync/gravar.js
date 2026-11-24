// Grava as vendas montadas da réplica (transformar.js) nas tabelas que o portal, o mrk-core e o app leem:
// movimento_caixa, sales e api_pagamentos. Uma transação por loja e período.
//
// O estado do período fica igual ao da réplica: atualiza pelas mesmas chaves que os jobs da API usam (o id do
// caixa e do item segue a mesma fórmula da API, então a primeira gravação sobrescreve o que a API tinha) e apaga
// o que não existe mais na réplica (conta reaberta, item antigo de NFC-e recriada). Só para lojas com "Fonte das
// vendas" = MrkSync, que a API do Menew não processa mais.

const crypto = require('crypto');

const COLUNAS_CAIXA = [
    'id', 'num_controle', 'redeId', 'rede', 'lojaId', 'loja', 'modoVenda', 'idModoVenda', 'hora', 'idAtendente',
    'codAtendente', 'nomeAtendente', 'vlDesconto', 'vlAcrescimo', 'vlTotalReceber', 'vlTotalRecebido',
    'vlServicoRecebido', 'vlTrocoFormasPagto', 'vlRepique', 'vlTaxaEntrega', 'numPessoas', 'operacaoId', 'maquinaId',
    'nomeMaquina', 'maquinaCod', 'maquinaPortaFiscal', 'periodoId', 'periodoCod', 'periodoNome', 'cancelado',
    'modoVenda2', 'dataAbertura', 'dataFechamento', 'dataContabil',
];

const COLUNAS_ITEM = [
    'idItemVenda', 'valorBruto', 'valorUnitario', 'valorUnitarioLiquido', 'valorLiquido', 'modoVenda', 'idModoVenda',
    'quantidade', 'dtLancamento', 'unidade', 'lojaId', 'idMaterial', 'codMaterial', 'descricao', 'grupo__idGrupo',
    'grupo__codigo', 'grupo__descricao', '__nfNumeroC', 'custom_code', 'system_unit_id',
];

const COLUNAS_PAGAMENTO = [
    'uuid', 'id_operacao', 'id_loja', 'system_unit_id', 'nome_loja', 'num_pedido', 'seq_pedido', 'data_contabil',
    'status_pagamento', 'data_lancamento', 'hora_lancamento', 'id_m', 'descricao', 'data_vencimento', 'dias_vencimento',
    'valor', 'taxa_comissao', 'valor_comissao', 'valor_liquido', 'parcela', 'nsu', 'origem', 'adquirente', 'autorizacao',
    'id_tipo', 'tipo_pagamento', 'id_bandeira', 'bandeira', 'cnpj_adquirente',
];

/** INSERT em lote com ON DUPLICATE KEY UPDATE das colunas que não fazem parte da chave. */
async function upsert(conn, tabela, colunas, linhas, chave, extraUpdate = '') {
    for (let i = 0; i < linhas.length; i += 300) {
        const lote = linhas.slice(i, i + 300);
        const valores = [];
        for (const l of lote) for (const c of colunas) valores.push(l[c] ?? null);
        const atualiza = colunas.filter((c) => !chave.includes(c)).map((c) => `\`${c}\` = VALUES(\`${c}\`)`);
        if (extraUpdate) atualiza.push(extraUpdate);
        await conn.query(
            `INSERT INTO ${tabela} (${colunas.map((c) => `\`${c}\``).join(', ')}) VALUES ${lote
                .map(() => `(${colunas.map(() => '?').join(', ')})`)
                .join(', ')} ON DUPLICATE KEY UPDATE ${atualiza.join(', ')}`,
            valores
        );
    }
}

/** Apaga as linhas do período cuja chave não está na lista (em lotes, para não montar um NOT IN enorme). */
async function apagarForaDe(conn, sqlSelecionar, params, campoChave, manter, sqlApagar) {
    const [rows] = await conn.query(sqlSelecionar, params);
    const sobra = rows.map((r) => String(r[campoChave])).filter((k) => !manter.has(k));
    for (let i = 0; i < sobra.length; i += 500) {
        const lote = sobra.slice(i, i + 500);
        await conn.query(sqlApagar.replace('(?)', `(${lote.map(() => '?').join(',')})`), lote);
    }
    return sobra.length;
}

/**
 * @param {object} conn  conexão mysql2 (promise) com permissão de escrita
 * @param {{id:number, custom_code:string}} un
 * @param {{caixa:object[], vendas:object[], pagamentos:object[]}} sync  saída de montarVendas para [inicio, fim]
 */
async function gravarVendas(conn, un, sync, inicio, fim) {
    const cod = String(un.custom_code);
    const resultado = { caixa: sync.caixa.length, itens: sync.vendas.length, pagamentos: sync.pagamentos.length, caixa_removidas: 0, itens_removidos: 0, pagamentos_substituidos: 0 };

    await conn.beginTransaction();
    try {
        // Caixa: chave única (num_controle, lojaId, dataContabil)
        const contas = new Set(sync.caixa.map((c) => `${c.num_controle}|${c.dataContabil}`));
        resultado.caixa_removidas = await apagarForaDe(
            conn,
            "SELECT CONCAT(num_controle, '|', DATE_FORMAT(dataContabil, '%Y-%m-%d')) AS k, id FROM movimento_caixa WHERE lojaId = ? AND dataContabil BETWEEN ? AND ?",
            [cod, inicio, fim],
            'k',
            contas,
            "DELETE FROM movimento_caixa WHERE lojaId = '" + cod.replace(/'/g, '') + "' AND CONCAT(num_controle, '|', DATE_FORMAT(dataContabil, '%Y-%m-%d')) IN (?)"
        );
        await upsert(conn, 'movimento_caixa', COLUNAS_CAIXA, sync.caixa, ['id', 'num_controle', 'lojaId']);

        // Itens: chave idItemVenda
        const ids = new Set(sync.vendas.map((v) => String(v.idItemVenda)));
        resultado.itens_removidos = await apagarForaDe(
            conn,
            'SELECT idItemVenda FROM sales WHERE system_unit_id = ? AND dtLancamento BETWEEN ? AND ?',
            [un.id, `${inicio} 00:00:00`, `${fim} 23:59:59`],
            'idItemVenda',
            ids,
            'DELETE FROM sales WHERE system_unit_id = ' + Number(un.id) + ' AND idItemVenda IN (?)'
        );
        await upsert(conn, 'sales', COLUNAS_ITEM, sync.vendas, ['idItemVenda'], '`updated_at` = NOW()');

        // Pagamentos: sem chave natural (uuid novo a cada gravação), como o job da API faz: apaga o período e insere.
        const [del] = await conn.query('DELETE FROM api_pagamentos WHERE system_unit_id = ? AND data_contabil BETWEEN ? AND ?', [un.id, inicio, fim]);
        resultado.pagamentos_substituidos = del.affectedRows;
        const pags = sync.pagamentos.map((p) => ({ ...p, uuid: crypto.randomUUID() }));
        for (let i = 0; i < pags.length; i += 300) {
            const lote = pags.slice(i, i + 300);
            const valores = [];
            for (const l of lote) for (const c of COLUNAS_PAGAMENTO) valores.push(l[c] ?? null);
            await conn.query(
                `INSERT INTO api_pagamentos (${COLUNAS_PAGAMENTO.map((c) => `\`${c}\``).join(', ')}) VALUES ${lote
                    .map(() => `(${COLUNAS_PAGAMENTO.map(() => '?').join(', ')})`)
                    .join(', ')}`,
                valores
            );
        }

        await conn.commit();
    } catch (err) {
        await conn.rollback();
        throw err;
    }
    return resultado;
}

module.exports = { gravarVendas, COLUNAS_CAIXA, COLUNAS_ITEM, COLUNAS_PAGAMENTO };
