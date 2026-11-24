const test = require('node:test');
const assert = require('node:assert/strict');
const { montarVendas, classificarMeio, trunc2 } = require('../mrksync/transformar');
const { comparar } = require('../mrksync/comparar');

// Linhas no formato do Firebird do Menew (como chegam em integracao_menew_*.dados), baseadas em contas reais
// da RED Burger - Barra (custom_code 264596).
const unidade = { id: 4, custom_code: '264596', nome: 'RED BURGER N BAR - BARRA' };

const contas = [
    // Salão com NFC-e, 100% de desconto (conta 84254 de 15/11)
    { NUM_CONTROLE: 84254, STATUS: 2, DT_MOV: '2026-11-15T00:00:00.000', TN_MOV: 1, CAIXA: 3, MESA: 1, INTG_TIPO: null, DESCONTO: 9.89, ACRESCIMO: 0, TROCO: 0, DELIVERY_FEE: null, NPESSOAS: 1, DT_ABERTURA: '15/11/2026', HR_ABERTURA: '17:15', DT_FECHA: '15/11/2026', HR_FECHA: '2309' },
    // Delivery iFood com taxa de serviço e troco lançado como pagamento negativo
    { NUM_CONTROLE: 84300, STATUS: 2, DT_MOV: '2026-11-15T00:00:00.000', TN_MOV: 1, CAIXA: 2, MESA: 9, INTG_TIPO: 'IFOOD', DESCONTO: 0, ACRESCIMO: 7.5, TROCO: 4.5, DELIVERY_FEE: 6.99, NPESSOAS: 1, DT_ABERTURA: '15/11/2026', HR_ABERTURA: '23:50', DT_FECHA: '16/11/2026', HR_FECHA: '0012' },
    // Fechada sem NFC-e: não entra no caixa nem nos itens, mas o pagamento entra (como a API faz)
    { NUM_CONTROLE: 84319, STATUS: 2, DT_MOV: '2026-11-15T00:00:00.000', TN_MOV: 1, CAIXA: 3, MESA: 53, DESCONTO: 0, ACRESCIMO: 0, NPESSOAS: 2, DT_ABERTURA: '15/11/2026', HR_ABERTURA: '19:53', DT_FECHA: '15/11/2026', HR_FECHA: '2038' },
    // Aberta / outro status: ignorada
    { NUM_CONTROLE: 84400, STATUS: 11, DT_MOV: '2026-11-15T00:00:00.000', TN_MOV: 1, CAIXA: 3, MESA: 4 },
];
const itens = [
    { NUM_CONTROLE: 84254, SEQUENCIAL: 1, STATUS: 2, CANCELA: 0, CODIGO: 1101, PRECO: 9.9, QUANT: 1 },
    { NUM_CONTROLE: 84300, SEQUENCIAL: 1, STATUS: 2, CANCELA: 0, CODIGO: 5000, PRECO: 45.9, QUANT: 1 },
    // Item com CANCELA=1 e STATUS 2 entra no total a receber (regra conferida na API)
    { NUM_CONTROLE: 84300, SEQUENCIAL: 2, STATUS: 2, CANCELA: 1, CODIGO: 1100, PRECO: 10, QUANT: 2 },
    // STATUS diferente de 2 não entra
    { NUM_CONTROLE: 84300, SEQUENCIAL: 3, STATUS: 1, CANCELA: 0, CODIGO: 1100, PRECO: 99, QUANT: 1 },
];
const pagamentos = [
    { NUM_CONTROLE: 84254, SEQUENCIAL: 1, VALOR: 0.01, FORMA_PAG: 1, FORMA_COMP: 0 },
    { NUM_CONTROLE: 84300, SEQUENCIAL: 1, VALOR: 64.99, FORMA_PAG: 17, FORMA_COMP: 0, ADQUIRENTE: 'IFOOD' },
    { NUM_CONTROLE: 84300, SEQUENCIAL: 2, VALOR: -4.5, FORMA_PAG: 1, FORMA_COMP: 0 },
    { NUM_CONTROLE: 84319, SEQUENCIAL: 1, VALOR: 607.4, FORMA_PAG: 3, FORMA_COMP: 3 },
];
const notas = [
    { NUM_CONTROLE: 84254, NUMERO_NFC: 80150, OCORRENCIA: 'A' },
    // Nota sem certificado (N) também conta, como na API
    { NUM_CONTROLE: 84300, NUMERO_NFC: 80160, OCORRENCIA: 'N' },
];
const itensNota = [
    { NUMERO_NFC: 80150, CODIGO: 319001, PRODUTO: '1101', QUANTIDADE: 1, PRECO_UNITARIO: 9.9, VALOR_TOTAL: 9.9, VALOR_DESCONTO: 9.89, UNIDADE: 'UND', SITUACAO: 'A', DESCRICAO_PRODUTO: 'REFRI LATA' },
    { NUMERO_NFC: 80160, CODIGO: 319010, PRODUTO: '5000', QUANTIDADE: 1, PRECO_UNITARIO: 45.9, VALOR_TOTAL: 45.9, VALOR_DESCONTO: 0, UNIDADE: 'UND', SITUACAO: 'A' },
    // Taxa de serviço lançada como produto 9000, quantidade fracionada (a coluna é inteira: trunca)
    { NUMERO_NFC: 80160, CODIGO: 319011, PRODUTO: '9000', QUANTIDADE: 7.5, PRECO_UNITARIO: 1, VALOR_TOTAL: 7.5, VALOR_DESCONTO: 0.01, UNIDADE: 'UND', SITUACAO: 'A' },
];
const replica = {
    contas, itens, pagamentos, notas, itensNota,
    operadores: [{ NUMERO: 2, NOME: 'CAIXA' }, { NUMERO: 3, NOME: 'EDNA SANTOS' }],
    produtos: [{ CODIGO: 1101, NOME: 'COCA COLA LATA', CATEG: 11 }, { CODIGO: 5000, NOME: 'RED BURGER', CATEG: 27 }, { CODIGO: 9000, NOME: 'SERVICO OPCIONAL', CATEG: 53 }],
    categorias: [{ CODIGO: 11, NOME: 'BEBIDAS' }, { CODIGO: 27, NOME: 'SMASH' }, { CODIGO: 53, NOME: 'CODIGOS INTERNOS' }],
    formas: [{ NUMERO: 1, PRAZO: null }, { NUMERO: 3, PRAZO: 1 }, { NUMERO: 17, PRAZO: null }],
    meios: [
        { id_externo: 10, nome: 'DINHEIRO', taxa_comissao: 0 },
        { id_externo: 33, nome: 'MASTER CREDITO', taxa_comissao: 2.9 },
        { id_externo: 170, nome: 'IFOOD ONLINE', taxa_comissao: null },
    ],
};

test('caixa: só contas fechadas com NFC-e, nos campos que a API grava', () => {
    const r = montarVendas({ unidade, ...replica });
    assert.deepEqual(r.caixa.map((c) => c.num_controle), ['84254', '84300']);
    assert.deepEqual(r.ignoradas.semNota, [84319]);
    assert.equal(r.ignoradas.naoFechadas, 1);

    const salao = r.caixa[0];
    assert.equal(salao.id, '2645969984254' + '88' + '80150');
    assert.equal(salao.lojaId, '264596');
    assert.equal(salao.operacaoId, '264596-20261115.1-3.84254');
    assert.equal(salao.modoVenda, 'SALAO');
    assert.equal(salao.idModoVenda, 3);
    assert.equal(salao.hora, 17);
    assert.equal(salao.idAtendente, 3);
    assert.equal(salao.nomeAtendente, 'EDNA SANTOS');
    assert.equal(salao.vlDesconto, 9.89);
    assert.equal(salao.vlTotalReceber, 9.9);
    assert.equal(salao.vlTotalRecebido, 0.01);
    assert.equal(salao.periodoNome, 'Turno 1');
    assert.equal(salao.dataAbertura, '2026-11-15 17:15:00');
    assert.equal(salao.dataFechamento, '2026-11-15 23:09:00');
    assert.equal(salao.dataContabil, '2026-11-15');

    const delivery = r.caixa[1];
    assert.equal(delivery.modoVenda, 'DELIVERY');
    assert.equal(delivery.modoVenda2, 'DELIVERY');
    assert.equal(delivery.idModoVenda, 2);
    assert.equal(delivery.vlServicoRecebido, 7.5);
    assert.equal(delivery.vlAcrescimo, 7.5);
    assert.equal(delivery.vlTaxaEntrega, 6.99);
    assert.equal(delivery.vlTrocoFormasPagto, 4.5);
    // 45,90 + 2 × 10,00 (CANCELA=1 com STATUS 2 entra); o item com STATUS 1 não
    assert.equal(delivery.vlTotalReceber, 65.9);
    // a soma inclui a linha negativa do troco, como a API
    assert.equal(delivery.vlTotalRecebido, 60.49);
    // fechou depois da meia-noite: a API usa a data contábil com a hora do fechamento
    assert.equal(delivery.dataFechamento, '2026-11-15 00:12:00');
});

test('itens: vêm dos itens da NFC-e, com a taxa de serviço como produto 9000', () => {
    const r = montarVendas({ unidade, ...replica });
    assert.equal(r.vendas.length, 3);
    const refri = r.vendas.find((v) => v.codMaterial === 1101);
    assert.equal(refri.idItemVenda, '26459699319001' + '88' + '80150');
    assert.equal(refri.valorBruto, 9.9);
    assert.equal(refri.valorLiquido, 0.01);
    assert.equal(refri.descricao, 'COCA COLA LATA');
    assert.equal(refri.grupo__descricao, 'BEBIDAS');
    assert.equal(refri.dtLancamento, '2026-11-15 00:00:00');
    assert.equal(refri.modoVenda, 'SALAO');
    assert.equal(refri.system_unit_id, 4);
    const servico = r.vendas.find((v) => v.codMaterial === 9000);
    assert.equal(servico.quantidade, 7);
    assert.equal(servico.valorBruto, 7.5);
    assert.equal(servico.valorLiquido, 7.49);
    assert.equal(servico.valorUnitarioLiquido, 0.99);
});

test('pagamentos: todas as contas fechadas, sem a linha negativa, com o código do meio da nuvem do Menew', () => {
    const r = montarVendas({ unidade, ...replica });
    assert.deepEqual(r.pagamentos.map((p) => `${p.num_pedido}/${p.seq_pedido}`), ['84254/1', '84300/1', '84319/1']);
    const cartao = r.pagamentos.find((p) => p.num_pedido === 84319);
    assert.equal(cartao.id_m, 33);
    assert.equal(cartao.descricao, 'MASTER CREDITO');
    assert.equal(cartao.taxa_comissao, 2.9);
    assert.equal(cartao.valor_comissao, 17.61);
    assert.equal(cartao.valor_liquido, 589.79);
    assert.equal(cartao.dias_vencimento, 1);
    assert.equal(cartao.data_vencimento, '2026-11-16');
    assert.equal(cartao.id_tipo, 3);
    assert.equal(cartao.bandeira, 'Master');
    const ifood = r.pagamentos.find((p) => p.num_pedido === 84300);
    assert.equal(ifood.id_m, 170);
    assert.equal(ifood.descricao, 'IFOOD ONLINE');
    assert.equal(ifood.id_tipo, 99);
});

test('classificação do meio e truncamento do unitário líquido', () => {
    assert.deepEqual(classificarMeio('VISA DEBITO'), { id_tipo: 4, tipo_pagamento: 'Cartão Débito', id_bandeira: 1, bandeira: 'Visa' });
    assert.deepEqual(classificarMeio('DINHEIRO'), { id_tipo: 1, tipo_pagamento: 'Dinheiro', id_bandeira: null, bandeira: null });
    assert.equal(trunc2(119.78 / 4), 29.94);
    assert.equal(trunc2(87.67 / 2), 43.83);
    assert.equal(trunc2(10 / 2), 5);
});

test('comparar: sem diferença quando a API gravou o mesmo', () => {
    const sync = montarVendas({ unidade, ...replica });
    const api = { caixa: sync.caixa.map((c) => ({ ...c })), vendas: sync.vendas.map((v) => ({ ...v })), pagamentos: sync.pagamentos.map((p) => ({ ...p })) };
    const rel = comparar(sync, api);
    assert.equal(rel.igual, true);
    assert.equal(rel.contagem.contas_iguais, 2);
    assert.equal(rel.porDia[0].igual, true);
});

test('comparar: aponta campo diferente, conta faltando e nota com itens recriados', () => {
    const sync = montarVendas({ unidade, ...replica });
    const api = {
        caixa: [{ ...sync.caixa[0], vlTotalRecebido: 1 }, { ...sync.caixa[1], num_controle: '99999' }],
        // mesma nota, item com id antigo (o PDV recriou os itens): vai para notas recriadas, não reprova
        vendas: sync.vendas.map((v, i) => (i === 0 ? { ...v, idItemVenda: '2645969931800088' + '80150' } : { ...v })),
        pagamentos: sync.pagamentos.map((p) => ({ ...p })),
    };
    const rel = comparar(sync, api);
    assert.equal(rel.igual, false);
    assert.deepEqual(rel.diferencas.caixa[0].campos.map((c) => c.campo), ['vlTotalRecebido']);
    assert.equal(rel.diferencas.contas_so_api[0].conta, 99999);
    assert.equal(rel.diferencas.contas_so_sync[0].conta, 84300);
    assert.equal(rel.contagem.notas_recriadas, 1);
    assert.equal(rel.diferencas.produtos.length, 0);
});

test('comparar: lê o dia de um DATE do mysql2 sem depender do fuso', () => {
    const sync = montarVendas({ unidade, ...replica });
    const api = { caixa: sync.caixa.map((c) => ({ ...c, dataContabil: new Date(2026, 10, 15) })), vendas: [], pagamentos: [] };
    const rel = comparar({ caixa: sync.caixa, vendas: [], pagamentos: [] }, api);
    assert.equal(rel.contagem.contas_iguais, 2);
});

test('comparar: nota que só existe na réplica (itens da API ainda não importados) é diferença, não nota recriada', () => {
    const sync = montarVendas({ unidade, ...replica });
    const api = { caixa: sync.caixa.map((c) => ({ ...c })), vendas: [], pagamentos: sync.pagamentos.map((p) => ({ ...p })) };
    const rel = comparar(sync, api);
    assert.equal(rel.contagem.notas_recriadas, 0);
    assert.equal(rel.igual, false);
    assert.equal(rel.diferencas.produtos.length, 3);
    assert.equal(rel.porDia[0].produtos_diferentes, 3);
    assert.equal(rel.porDia[0].igual, false);
});
