const axios = require('axios');

async function test() {
    const MENEW_URL = 'https://public-api.prod.menew.cloud/';
    
    // Login
    const loginPayload = {
        token: null,
        requests: {
            jsonrpc: '2.0',
            method: 'Usuario/login',
            params: { usuario: 'batech', token: 'X7K1g6VJLrcWPM2adw2O' },
            id: '1'
        }
    };
    
    const loginRes = await axios.post(MENEW_URL, loginPayload);
    const token = loginRes.data.result;
    
    const lojaId = '257985'; // Casa Opera
    
    // Vamos buscar os 3 dias
    const datas = ['2026-05-31', '2026-06-01', '2026-06-02'];
    
    console.log('=== Análise de Datas Contábeis vs Lançamento na Menew ===\n');
    
    for (const dataRef of datas) {
        console.log(`\n>>> Consultando dataRef: ${dataRef} <<<`);
        
        // 1. itemvenda
        const itemRes = await axios.post(MENEW_URL, {
            token: token,
            requests: {
                jsonrpc: '2.0',
                method: 'itemvenda',
                params: { lojas: lojaId, dtinicio: dataRef, dtfim: dataRef },
                id: '1'
            }
        });
        const itens = itemRes.data.result || [];
        
        // Agrupa itens por data física (extraída de dtLancamento ex: "2026-06-01 12:34:56")
        const itensPorLancamento = {};
        let sumTotalLiq = 0;
        itens.forEach(i => {
            const dataLanc = i.dtLancamento.substring(0, 10);
            itensPorLancamento[dataLanc] = (itensPorLancamento[dataLanc] || 0) + parseFloat(i.valorLiquido || 0);
            sumTotalLiq += parseFloat(i.valorLiquido || 0);
        });
        
        console.log(`  [itemvenda] Total retornado para ${dataRef}: R$ ${sumTotalLiq.toFixed(2)} (${itens.length} itens)`);
        console.log('  Agrupado por data física de lançamento (dtLancamento):');
        for (const [dt, total] of Object.entries(itensPorLancamento)) {
            console.log(`    - ${dt}: R$ ${total.toFixed(2)}`);
        }
        
        // 2. movimentocaixa
        const movRes = await axios.post(MENEW_URL, {
            token: token,
            requests: {
                jsonrpc: '2.0',
                method: 'movimentocaixa',
                params: { lojas: lojaId, dtinicio: dataRef, dtfim: dataRef },
                id: '1'
            }
        });
        const movimentos = movRes.data.result || [];
        const movsPorAbertura = {};
        const movsPorFechamento = {};
        const movsPorContabil = {};
        let sumMovRecebido = 0;
        
        movimentos.forEach(m => {
            const dtAbert = m.dataAbertura.substring(0, 10);
            const dtFech = m.dataFechamento ? m.dataFechamento.substring(0, 10) : 'Aberto';
            const dtCont = m.dataContabil.substring(0, 10);
            
            movsPorAbertura[dtAbert] = (movsPorAbertura[dtAbert] || 0) + parseFloat(m.vlTotalRecebido || 0);
            movsPorFechamento[dtFech] = (movsPorFechamento[dtFech] || 0) + parseFloat(m.vlTotalRecebido || 0);
            movsPorContabil[dtCont] = (movsPorContabil[dtCont] || 0) + parseFloat(m.vlTotalRecebido || 0);
            sumMovRecebido += parseFloat(m.vlTotalRecebido || 0);
        });
        
        console.log(`  [movimentocaixa] Total retornado para ${dataRef}: R$ ${sumMovRecebido.toFixed(2)} (${movimentos.length} movimentos)`);
        console.log('  Agrupado por data de Abertura:');
        for (const [dt, total] of Object.entries(movsPorAbertura)) {
            console.log(`    - ${dt}: R$ ${total.toFixed(2)}`);
        }
        console.log('  Agrupado por data de Fechamento:');
        for (const [dt, total] of Object.entries(movsPorFechamento)) {
            console.log(`    - ${dt}: R$ ${total.toFixed(2)}`);
        }
        console.log('  Agrupado por data Contábil:');
        for (const [dt, total] of Object.entries(movsPorContabil)) {
            console.log(`    - ${dt}: R$ ${total.toFixed(2)}`);
        }
    }
}

test().catch(console.error);
