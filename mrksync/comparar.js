// Compara as vendas montadas da réplica (transformar.js) com o que a API do Menew gravou em movimento_caixa,
// sales e api_pagamentos. Função pura: devolve um relatório com os totais por dia e cada diferença.
//
// Os itens são comparados somados por dia e produto, não pelo id: quando o PDV recria os itens de uma NFC-e,
// a nuvem do Menew fica com os ids antigos (e às vezes duplicados), e o sales nunca apaga.

const num = (v) => (v === null || v === undefined || v === '' ? 0 : Number(v) || 0);
const r2 = (v) => Math.round((v + Number.EPSILON) * 100) / 100;
const dia = (v) => {
    // O mysql2 cria DATE/DATETIME no fuso local: os componentes locais são o dia gravado no banco.
    if (v instanceof Date) return `${v.getFullYear()}-${String(v.getMonth() + 1).padStart(2, '0')}-${String(v.getDate()).padStart(2, '0')}`;
    return String(v ?? '').slice(0, 10);
};

/** Campos do movimento_caixa conferidos conta a conta. dataFechamento e máquina ficam de fora (ver docs). */
const CAMPOS_CAIXA = [
    ['vlTotalRecebido', 'valor'],
    ['vlTotalReceber', 'valor'],
    ['vlDesconto', 'valor'],
    ['vlAcrescimo', 'valor'],
    ['vlServicoRecebido', 'valor'],
    ['vlTaxaEntrega', 'valor'],
    ['numPessoas', 'numero'],
    ['hora', 'numero'],
    ['periodoId', 'numero'],
    ['idAtendente', 'numero'],
    ['modoVenda', 'texto'],
    ['modoVenda2', 'texto'],
    ['operacaoId', 'texto'],
    ['nomeAtendente', 'texto'],
];

const CAMPOS_PAGAMENTO = [
    ['valor', 'valor'],
    ['id_m', 'numero'],
    ['descricao', 'texto'],
    ['taxa_comissao', 'valor'],
];

function igual(a, b, tipo) {
    if (tipo === 'valor') return r2(num(a)) === r2(num(b));
    if (tipo === 'numero') return num(a) === num(b);
    return String(a ?? '').trim() === String(b ?? '').trim();
}

function totalDia(mapa, d) {
    if (!mapa.has(d)) mapa.set(d, { contas_api: 0, contas_sync: 0, recebido_api: 0, recebido_sync: 0, itens_bruto_api: 0, itens_bruto_sync: 0, produtos_diferentes: 0, pagamentos_api: 0, pagamentos_sync: 0 });
    return mapa.get(d);
}

/**
 * @param {{caixa:object[], vendas:object[], pagamentos:object[]}} sync  saída de montarVendas
 * @param {{caixa:object[], vendas:object[], pagamentos:object[]}} api   linhas lidas de movimento_caixa, sales e api_pagamentos
 * @param {{maxExemplos?:number}} [opcoes]
 */
function comparar(sync, api, opcoes = {}) {
    const max = opcoes.maxExemplos ?? 50;
    const dias = new Map();
    const diferencas = { caixa: [], contas_so_api: [], contas_so_sync: [], produtos: [], pagamentos: [], pagamentos_so_api: [], pagamentos_so_sync: [] };
    const contagem = { contas: 0, contas_iguais: 0, produtos: 0, produtos_iguais: 0, pagamentos: 0, pagamentos_iguais: 0 };
    const guardar = (lista, item) => lista.length < max && lista.push(item);
    const notasRecriadas = [];

    // Contas (movimento_caixa)
    const chaveConta = (m) => `${dia(m.dataContabil)}|${num(m.num_controle)}`;
    const apiCaixa = new Map((api.caixa || []).filter((m) => num(m.cancelado) === 0).map((m) => [chaveConta(m), m]));
    const syncCaixa = new Map((sync.caixa || []).map((m) => [chaveConta(m), m]));
    for (const [k, a] of apiCaixa) {
        const t = totalDia(dias, dia(a.dataContabil));
        t.contas_api++;
        t.recebido_api += num(a.vlTotalRecebido);
        const s = syncCaixa.get(k);
        if (!s) {
            guardar(diferencas.contas_so_api, { conta: num(a.num_controle), dia: dia(a.dataContabil), recebido: r2(num(a.vlTotalRecebido)) });
            continue;
        }
        contagem.contas++;
        const campos = CAMPOS_CAIXA.filter(([c, tipo]) => !igual(a[c], s[c], tipo)).map(([c]) => ({ campo: c, api: a[c], sync: s[c] }));
        if (campos.length === 0) contagem.contas_iguais++;
        else guardar(diferencas.caixa, { conta: num(a.num_controle), dia: dia(a.dataContabil), campos });
    }
    for (const [k, s] of syncCaixa) {
        const t = totalDia(dias, dia(s.dataContabil));
        t.contas_sync++;
        t.recebido_sync += num(s.vlTotalRecebido);
        if (!apiCaixa.has(k)) guardar(diferencas.contas_so_sync, { conta: num(s.num_controle), dia: dia(s.dataContabil), recebido: s.vlTotalRecebido });
    }

    // Itens (sales). Notas cujos itens não têm os mesmos ids dos dois lados (o PDV recriou os itens e a nuvem do
    // Menew ficou com os antigos) vão para "notas_recriadas"; o resto é comparado somado por dia e produto.
    const nfDe = (v) => num(v.__nfNumeroC ?? v.nf);
    const idsApi = new Set((api.vendas || []).map((v) => String(v.idItemVenda)));
    const idsSync = new Set((sync.vendas || []).map((v) => String(v.idItemVenda)));
    // Recriada é a nota que existe dos dois lados com ids de item diferentes. Nota que só existe de um lado (ex.: o
    // job de itens da API ainda não rodou) não entra aqui: cai na comparação por produto e aparece como diferença.
    const notasApi = new Set((api.vendas || []).map(nfDe));
    const notasSync = new Set((sync.vendas || []).map(nfDe));
    const recriadas = new Set(
        [
            ...(api.vendas || []).filter((v) => !idsSync.has(String(v.idItemVenda))).map(nfDe),
            ...(sync.vendas || []).filter((v) => !idsApi.has(String(v.idItemVenda))).map(nfDe),
        ].filter((nf) => notasApi.has(nf) && notasSync.has(nf))
    );
    const porNota = new Map();
    const somar = (linhas, lado) => {
        const m = new Map();
        for (const v of linhas || []) {
            const d = dia(v.dtLancamento);
            totalDia(dias, d)[`itens_bruto_${lado}`] += num(v.valorBruto);
            if (recriadas.has(nfDe(v))) {
                const n = porNota.get(nfDe(v)) || { nota: nfDe(v), dia: d, itens_api: 0, itens_sync: 0, bruto_api: 0, bruto_sync: 0 };
                n[`itens_${lado}`]++;
                n[`bruto_${lado}`] += num(v.valorBruto);
                porNota.set(nfDe(v), n);
                continue;
            }
            const k = `${d}|${num(v.codMaterial)}`;
            const a = m.get(k) || { quantidade: 0, valorBruto: 0, valorLiquido: 0 };
            a.quantidade += num(v.quantidade);
            a.valorBruto += num(v.valorBruto);
            a.valorLiquido += num(v.valorLiquido);
            m.set(k, a);
        }
        return m;
    };
    const apiProd = somar(api.vendas, 'api'), syncProd = somar(sync.vendas, 'sync');
    for (const k of new Set([...apiProd.keys(), ...syncProd.keys()])) {
        const [d, codigo] = k.split('|');
        const a = apiProd.get(k) || { quantidade: 0, valorBruto: 0, valorLiquido: 0 };
        const s = syncProd.get(k) || { quantidade: 0, valorBruto: 0, valorLiquido: 0 };
        contagem.produtos++;
        const ok = a.quantidade === s.quantidade && r2(a.valorBruto) === r2(s.valorBruto) && r2(a.valorLiquido) === r2(s.valorLiquido);
        if (ok) contagem.produtos_iguais++;
        else totalDia(dias, d).produtos_diferentes++;
        if (!ok) guardar(diferencas.produtos, { dia: d, produto: Number(codigo), api: { q: a.quantidade, bruto: r2(a.valorBruto), liquido: r2(a.valorLiquido) }, sync: { q: s.quantidade, bruto: r2(s.valorBruto), liquido: r2(s.valorLiquido) } });
    }
    contagem.notas_recriadas = porNota.size;
    for (const n of [...porNota.values()].sort((x, y) => x.nota - y.nota)) {
        guardar(notasRecriadas, { ...n, bruto_api: r2(n.bruto_api), bruto_sync: r2(n.bruto_sync) });
    }

    // Pagamentos (api_pagamentos)
    const chavePag = (x) => `${num(x.num_pedido)}|${num(x.seq_pedido)}`;
    const apiPag = new Map((api.pagamentos || []).filter((x) => x.status_pagamento !== 'cancelado').map((x) => [chavePag(x), x]));
    const syncPag = new Map((sync.pagamentos || []).map((x) => [chavePag(x), x]));
    for (const [k, a] of apiPag) {
        totalDia(dias, dia(a.data_contabil)).pagamentos_api += num(a.valor);
        const s = syncPag.get(k);
        if (!s) {
            guardar(diferencas.pagamentos_so_api, { conta: num(a.num_pedido), seq: num(a.seq_pedido), valor: r2(num(a.valor)), meio: a.descricao });
            continue;
        }
        contagem.pagamentos++;
        const campos = CAMPOS_PAGAMENTO.filter(([c, tipo]) => !igual(a[c], s[c], tipo)).map(([c]) => ({ campo: c, api: a[c], sync: s[c] }));
        if (campos.length === 0) contagem.pagamentos_iguais++;
        else guardar(diferencas.pagamentos, { conta: num(a.num_pedido), seq: num(a.seq_pedido), campos });
    }
    for (const [k, s] of syncPag) {
        totalDia(dias, dia(s.data_contabil)).pagamentos_sync += num(s.valor);
        if (!apiPag.has(k)) guardar(diferencas.pagamentos_so_sync, { conta: num(s.num_pedido), seq: num(s.seq_pedido), valor: s.valor, meio: s.descricao });
    }

    const porDia = [...dias.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([d, t]) => {
            const linha = { dia: d };
            for (const [k, v] of Object.entries(t)) linha[k] = Number.isInteger(v) ? v : r2(v);
            // Os totais de itens podem diferir pelas notas recriadas; o que reprova o dia é produto diferente fora delas.
            linha.igual = t.contas_api === t.contas_sync && r2(t.recebido_api) === r2(t.recebido_sync) && r2(t.pagamentos_api) === r2(t.pagamentos_sync) && t.produtos_diferentes === 0;
            return linha;
        });

    // As notas recriadas são um defeito conhecido da nuvem do Menew: aparecem no relatório, mas não reprovam.
    const semDiferenca = Object.values(diferencas).every((l) => l.length === 0);
    return { igual: semDiferenca, contagem, porDia, diferencas, notasRecriadas };
}

module.exports = { comparar, CAMPOS_CAIXA, CAMPOS_PAGAMENTO };
