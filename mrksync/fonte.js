// "Fonte das vendas" por loja Menew (system_unit.menew_fonte_vendas, definida na tela de Integrações):
// 'api' = jobs da API do Menew; 'mrksync' = worker do MrkSync. Os jobs da API pulam as lojas em 'mrksync',
// para uma loja nunca ter as duas fontes gravando ao mesmo tempo.

const { getConnection } = require('../utils/utils');
const { log } = require('../utils/logger');

/** Ids das lojas em MrkSync. Sem a coluna (migration ainda não aplicada), nenhuma: os jobs seguem como antes. */
async function lojasComFonteMrkSync() {
    const conn = await getConnection();
    try {
        const [rows] = await conn.query("SELECT id FROM system_unit WHERE menew_fonte_vendas = 'mrksync'");
        return new Set(rows.map((r) => Number(r.id)));
    } catch (err) {
        if (err && err.code === 'ER_BAD_FIELD_ERROR') return new Set();
        throw err;
    } finally {
        conn.end();
    }
}

/** Tira da lista as lojas em MrkSync (campo do id: system_unit_id ou id) e registra quais pulou. */
async function semLojasMrkSync(unidades, origem) {
    const mrksync = await lojasComFonteMrkSync();
    if (mrksync.size === 0) return unidades;
    const fica = [];
    for (const u of unidades) {
        const id = Number(u.system_unit_id ?? u.id);
        if (mrksync.has(id)) log(`⏭️ ${u.name || id}: vendas pelo MrkSync, fora da API do Menew`, origem);
        else fica.push(u);
    }
    return fica;
}

module.exports = { lojasComFonteMrkSync, semLojasMrkSync };
