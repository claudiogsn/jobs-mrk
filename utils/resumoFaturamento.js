const campos = ['faturamento_bruto', 'faturamento_liquido', 'descontos', 'taxa_servico',
    'numero_clientes', 'numero_pedidos', 'pedidos_presencial', 'pedidos_delivery', 'ticket_medio', 'estatisticas_pendentes'];

function normalizarResumo(resposta) {
    if (!resposta || resposta.success === false || resposta.status === 'error' || resposta.error ||
        resposta.faturamento_bruto == null || resposta.faturamento_liquido == null || resposta.numero_pedidos == null) {
        throw new Error('A API não retornou um resumo de faturamento válido.');
    }
    const resumo = { ...resposta };
    for (const campo of campos) {
        const numero = Number(resposta[campo] ?? 0);
        if (!Number.isFinite(numero)) throw new Error(`Valor inválido no resumo: ${campo}`);
        resumo[campo] = numero;
    }
    resumo.faturamento_provisorio = resposta.faturamento_provisorio === true || resumo.estatisticas_pendentes > 0;
    return resumo;
}

function normalizarResumoGrupo(resposta) {
    if (!resposta || resposta.success !== true || !Array.isArray(resposta.data)) {
        throw new Error('A API não retornou um resumo de faturamento do grupo válido.');
    }
    return resposta.data.map(normalizarResumo);
}

function validarIntervalos(intervalos) {
    for (const campo of ['dt_inicio', 'dt_fim', 'dt_inicio_anterior', 'dt_fim_anterior']) {
        if (typeof intervalos?.[campo] !== 'string' || !/^\d{4}-\d{2}-\d{2}/.test(intervalos[campo])) {
            throw new Error('A API não retornou os períodos do resumo de faturamento.');
        }
    }
    return intervalos;
}

module.exports = { normalizarResumo, normalizarResumoGrupo, validarIntervalos };
