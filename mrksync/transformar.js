// Monta as vendas de uma loja a partir da réplica do PDV Menew (tabelas integracao_menew_*, linhas do Firebird),
// no mesmo formato que os jobs da API do Menew gravam: movimento_caixa, sales e api_pagamentos.
//
// Como a API faz (decisão de 23/11/2026): o caixa e os itens só têm as contas fechadas (STATUS 2) com registro de
// NFC-e, de qualquer ocorrência (autorizada, contingência, rejeitada ou sem certificado). Os pagamentos têm todas as
// contas fechadas, com ou sem nota, menos as linhas negativas (troco lançado como pagamento). Regras conferidas
// conta a conta contra a API na RED Burger - Barra, de 1 a 22/11/2026: ver docs/mrksync-vendas.md.
//
// Funções puras: recebem as linhas já lidas e não tocam no banco.

const num = (v) => {
    if (v === null || v === undefined || v === 'null' || v === '') return 0;
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
};
const texto = (v) => (v === null || v === undefined || v === 'null' ? null : String(v));
const r2 = (v) => Math.round((v + Number.EPSILON) * 100) / 100;
/** A API trunca (não arredonda) o unitário líquido: 29,945 vira 29,94. */
const trunc2 = (v) => Math.trunc(Math.round(v * 1e6) / 1e4) / 100;
/** "2026-11-15T00:00:00.000" → "2026-11-15". */
const dia = (v) => (texto(v) || '').slice(0, 10);
/** "15/11/2026" → "2026-11-15". */
const diaBr = (v) => {
    const m = /^(\d{2})\/(\d{2})\/(\d{4})/.exec(texto(v) || '');
    return m ? `${m[3]}-${m[2]}-${m[1]}` : null;
};
/** "17:15" ou "1715" → "17:15". */
const hhmm = (v) => {
    const s = (texto(v) || '').replace(':', '').padStart(4, '0');
    return /^\d{4}$/.test(s) ? `${s.slice(0, 2)}:${s.slice(2)}` : null;
};

const MODOS = { BALCAO: 1, DELIVERY: 2, SALAO: 3 };

/** DELIVERY quando veio de integração (iFood etc.), SALAO quando tem mesa, senão BALCAO. */
function modoVenda(c) {
    if (texto(c.INTG_TIPO)) return 'DELIVERY';
    return num(c.MESA) > 0 ? 'SALAO' : 'BALCAO';
}

/** Código da operação como a API monta: loja-AAAAMMDD.turno-caixa.conta. */
function operacaoId(codigoLoja, c) {
    return `${codigoLoja}-${dia(c.DT_MOV).replace(/-/g, '')}.${num(c.TN_MOV)}-${num(c.CAIXA)}.${num(c.NUM_CONTROLE)}`;
}

/** Tipo e bandeira do meio de pagamento, pelo nome (é como a nuvem do Menew classifica). */
function classificarMeio(nome) {
    const n = (nome || '').toUpperCase();
    let tipo = [99, 'Outros'];
    if (n.includes('DINHEIRO')) tipo = [1, 'Dinheiro'];
    else if (n.includes('DEBITO')) tipo = [4, 'Cartão Débito'];
    else if (n.includes('CREDITO') || n.includes('AMERICAN EXPRESS') || n.includes('AMEX')) tipo = [3, 'Cartão Crédito'];
    let bandeira = [99, 'Outros'];
    if (tipo[0] === 1) bandeira = [null, null];
    else if (n.includes('VISA')) bandeira = [1, 'Visa'];
    else if (n.includes('MASTER')) bandeira = [2, 'Master'];
    else if (n.includes('AMERICAN EXPRESS') || n.includes('AMEX')) bandeira = [3, 'Amex'];
    return { id_tipo: tipo[0], tipo_pagamento: tipo[1], id_bandeira: bandeira[0], bandeira: bandeira[1] };
}

function agrupar(linhas, chave) {
    const m = new Map();
    for (const l of linhas) {
        const k = chave(l);
        if (!m.has(k)) m.set(k, []);
        m.get(k).push(l);
    }
    return m;
}

/**
 * @param {object} p
 * @param {{id:number, custom_code:string, nome?:string}} p.unidade  system_unit da loja
 * @param {object[]} p.contas      TBCABCONTA
 * @param {object[]} p.itens       TBDETCONTA
 * @param {object[]} p.pagamentos  TBPAGCONTA
 * @param {object[]} p.notas       TBNFCE
 * @param {object[]} p.itensNota   TBNFCE_ITENS
 * @param {object[]} p.operadores  TBOPE
 * @param {object[]} p.produtos    TBPROD
 * @param {object[]} p.categorias  TBCATEG
 * @param {object[]} p.formas      TBFORMA
 * @param {object[]} p.meios       meios_pagamento da loja (id_externo, nome, taxa_comissao)
 */
function montarVendas(p) {
    const cod = String(p.unidade.custom_code);

    const notasPorConta = agrupar(p.notas || [], (n) => num(n.NUM_CONTROLE));
    const itensPorConta = agrupar(p.itens || [], (d) => num(d.NUM_CONTROLE));
    const pagsPorConta = agrupar(p.pagamentos || [], (x) => num(x.NUM_CONTROLE));
    const itensPorNota = agrupar(p.itensNota || [], (i) => num(i.NUMERO_NFC));
    const operador = new Map((p.operadores || []).map((o) => [num(o.NUMERO), texto(o.NOME)]));
    const produto = new Map((p.produtos || []).map((x) => [num(x.CODIGO), x]));
    const categoria = new Map((p.categorias || []).map((x) => [num(x.CODIGO), texto(x.NOME)]));
    const forma = new Map((p.formas || []).map((f) => [num(f.NUMERO), f]));
    const meio = new Map((p.meios || []).map((m) => [num(m.id_externo), m]));

    const caixa = [];
    const vendas = [];
    const pagamentos = [];
    const ignoradas = { semNota: [], naoFechadas: 0 };

    for (const c of p.contas || []) {
        const nc = num(c.NUM_CONTROLE);
        if (num(c.STATUS) !== 2) {
            ignoradas.naoFechadas++;
            continue;
        }
        const notas = (notasPorConta.get(nc) || []).sort((a, b) => num(b.NUMERO_NFC) - num(a.NUMERO_NFC));
        const dataContabil = dia(c.DT_MOV);
        const modo = modoVenda(c);
        const itens = (itensPorConta.get(nc) || []).filter((d) => num(d.STATUS) === 2);
        const pags = pagsPorConta.get(nc) || [];
        const op = operacaoId(cod, c);
        const fecha = hhmm(c.HR_FECHA);

        for (const x of pags) {
            const valor = r2(num(x.VALOR));
            if (valor <= 0) continue;
            const idM = num(x.FORMA_PAG) * 10 + num(x.FORMA_COMP);
            const m = meio.get(idM);
            const nome = m ? texto(m.nome) : null;
            const taxa = m && m.taxa_comissao != null ? Number(m.taxa_comissao) : null;
            const comissao = taxa ? r2((valor * taxa) / 100) : null;
            const prazo = num((forma.get(num(x.FORMA_PAG)) || {}).PRAZO);
            const venc = new Date(`${dataContabil}T12:00:00Z`);
            venc.setUTCDate(venc.getUTCDate() + prazo);
            pagamentos.push({
                system_unit_id: p.unidade.id,
                id_operacao: op,
                id_loja: String(p.unidade.id),
                nome_loja: p.unidade.nome || null,
                num_pedido: nc,
                seq_pedido: num(x.SEQUENCIAL),
                data_contabil: dataContabil,
                status_pagamento: 'recebido',
                data_lancamento: dataContabil,
                hora_lancamento: fecha ? fecha.replace(':', '') : null,
                id_m: idM,
                descricao: nome,
                data_vencimento: venc.toISOString().slice(0, 10),
                dias_vencimento: prazo,
                valor,
                taxa_comissao: taxa,
                valor_comissao: comissao,
                valor_liquido: comissao != null ? r2(valor - comissao) : valor,
                parcela: num(x.PARCELA) || 1,
                nsu: texto(x.NSU) || texto(x.NSU_ADQUIRENTE),
                origem: texto(x.ADQUIRENTE),
                adquirente: texto(x.ADQUIRENTE),
                autorizacao: null,
                ...classificarMeio(nome),
                cnpj_adquirente: null,
            });
        }

        if (notas.length === 0) {
            ignoradas.semNota.push(nc);
            continue;
        }
        const nf = num(notas[0].NUMERO_NFC);

        caixa.push({
            id: `${cod}99${nc}88${nf}`,
            num_controle: String(nc),
            redeId: '0',
            rede: '',
            lojaId: cod,
            loja: p.unidade.nome || null,
            modoVenda: modo,
            idModoVenda: MODOS[modo],
            hora: num(String(hhmm(c.HR_ABERTURA) || '').slice(0, 2)),
            idAtendente: num(c.CAIXA),
            codAtendente: num(c.CAIXA),
            nomeAtendente: operador.get(num(c.CAIXA)) || null,
            vlDesconto: r2(num(c.DESCONTO)),
            vlAcrescimo: r2(num(c.ACRESCIMO)),
            vlTotalReceber: r2(itens.reduce((s, d) => s + num(d.PRECO) * num(d.QUANT), 0)),
            vlTotalRecebido: r2(pags.reduce((s, x) => s + num(x.VALOR), 0)),
            vlServicoRecebido: r2(num(c.ACRESCIMO)),
            vlTrocoFormasPagto: r2(num(c.TROCO)),
            vlRepique: 0,
            vlTaxaEntrega: r2(num(c.DELIVERY_FEE)),
            numPessoas: num(c.NPESSOAS),
            operacaoId: op,
            maquinaId: null,
            nomeMaquina: null,
            maquinaCod: null,
            maquinaPortaFiscal: null,
            periodoId: num(c.TN_MOV),
            periodoCod: num(c.TN_MOV),
            periodoNome: `Turno ${num(c.TN_MOV)}`,
            cancelado: 0,
            modoVenda2: modo,
            dataAbertura: `${diaBr(c.DT_ABERTURA) || dataContabil} ${hhmm(c.HR_ABERTURA) || '00:00'}:00`,
            dataFechamento: fecha ? `${dataContabil} ${fecha}:00` : null,
            dataContabil,
        });

        for (const n of notas) {
            for (const i of itensPorNota.get(num(n.NUMERO_NFC)) || []) {
                if ((texto(i.SITUACAO) || 'A') !== 'A') continue;
                const codProd = num(i.PRODUTO);
                const pr = produto.get(codProd);
                const q = num(i.QUANTIDADE);
                const liquido = r2(num(i.VALOR_TOTAL) - num(i.VALOR_DESCONTO));
                const categ = pr ? num(pr.CATEG) : null;
                vendas.push({
                    idItemVenda: `${cod}99${num(i.CODIGO)}88${num(i.NUMERO_NFC)}`,
                    valorBruto: r2(num(i.VALOR_TOTAL)),
                    valorUnitario: r2(num(i.PRECO_UNITARIO)),
                    valorUnitarioLiquido: q ? trunc2(liquido / q) : 0,
                    valorLiquido: liquido,
                    modoVenda: modo,
                    idModoVenda: MODOS[modo],
                    quantidade: Math.trunc(q),
                    dtLancamento: `${dataContabil} 00:00:00`,
                    unidade: texto(i.UNIDADE),
                    lojaId: p.unidade.id,
                    idMaterial: codProd,
                    codMaterial: codProd,
                    descricao: (pr && texto(pr.NOME)) || texto(i.DESCRICAO_PRODUTO),
                    grupo__idGrupo: categ,
                    grupo__codigo: categ,
                    grupo__descricao: categ != null ? categoria.get(categ) || null : null,
                    __nfNumeroC: num(i.NUMERO_NFC),
                    custom_code: cod,
                    system_unit_id: p.unidade.id,
                });
            }
        }
    }

    return { caixa, vendas, pagamentos, ignoradas };
}

module.exports = { montarVendas, modoVenda, operacaoId, classificarMeio, trunc2, hhmm, diaBr };
