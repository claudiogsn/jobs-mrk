const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { normalizarResumo, normalizarResumoGrupo } = require('../utils/resumoFaturamento');

function load(relative, mocks) {
    const filename = path.resolve(__dirname, '..', relative);
    const realRequire = createRequire(filename);
    const module = { exports: {} };
    const requireMock = id => {
        if (id === 'dotenv') return { config() {} };
        if (id === '../utils/logger') return { log() {} };
        if (Object.hasOwn(mocks, id)) return mocks[id];
        return realRequire(id);
    };
    vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {
        module, exports: module.exports, require: requireMock, console,
        process: { env: {} }, setTimeout, clearTimeout, Date,
    }, { filename });
    return module.exports;
}
const moeda = value => 'R$ ' + Number(value).toFixed(2).replace('.', ',');
const resumo = (valor, extras = {}) => ({ faturamento_bruto: valor, faturamento_liquido: valor, numero_pedidos: 1, ...extras });
const periodos = { dt_inicio:'2026-09-28 00:00:00', dt_fim:'2026-10-04 23:59:59', dt_inicio_anterior:'2026-09-21 00:00:00', dt_fim_anterior:'2026-09-27 23:59:59' };

test('resumos numéricos e erros de API são distinguidos de faturamento zero', () => {
    assert.equal(normalizarResumo(resumo('100.25')).faturamento_bruto, 100.25);
    assert.equal(normalizarResumo(resumo(0)).faturamento_bruto, 0);
    for (const invalido of [null, {}, {success:false}, {status:'error'}, resumo('abc')]) {
        assert.throws(() => normalizarResumo(invalido));
    }
    assert.throws(() => normalizarResumoGrupo({success:false,data:[]}));
});

test('mensagem diária utiliza o ID interno e os valores reais da API', async () => {
    const enviados = [];
    const worker = load('workers/WorkerDisparoFaturamento.js', {
        '../utils/rabbitmq': { connect:async()=>{}, QUEUES:{WHATSAPP:'test'}, publishToQueue:async(_q,p)=>enviados.push(p) },
        '../utils/utils': {
            formatCurrency:moeda, calcularVariacao:()=> '0%',
            callPHP:async(method,data)=> {
                if(method==='getUnitsByGroup') return [{system_unit_id:24,custom_code:'uuid-iryna',name:'Casa Iryna'}];
                assert.equal(method,'generateResumoFinanceiroPorLoja');
                assert.equal(data.system_unit_id,24);
                return resumo('71746.57',{estatisticas_pendentes:1});
            },
        },
    });
    assert.equal(await worker.enviarResumoDiario({nome:'Teste',telefone:'destino-ficticio'},{id:1,nome:'Teste'},'2026-10-04'),true);
    assert.equal(enviados.length,1);
    assert.match(enviados[0].mensagem,/71746,57/);
    assert.match(enviados[0].mensagem,/Valor importado/);
    assert.match(enviados[0].mensagem,/pendentes/);
});

test('mensagem diária não é enviada quando o endpoint falha', async () => {
    let enviados=0;
    const worker=load('workers/WorkerDisparoFaturamento.js',{
        '../utils/rabbitmq':{connect:async()=>{},QUEUES:{WHATSAPP:'test'},publishToQueue:async()=>enviados++},
        '../utils/utils':{formatCurrency:moeda,calcularVariacao:()=> '0%',callPHP:async method=>method==='getUnitsByGroup'?[{system_unit_id:24,custom_code:'uuid',name:'Iryna'}]:{status:'error',message:'SQL falhou'}},
    });
    await assert.rejects(worker.enviarResumoDiario({nome:'Teste',telefone:'ficticio'},{id:1,nome:'Teste'},'2026-10-04'),/resumo/);
    assert.equal(enviados,0);
});

test('resumo semanal soma números recebidos como texto e sinaliza pendências', async () => {
    const enviados=[];
    const worker=load('workers/WorkerReportPdfWeekly.js',{
        '../utils/utils':{
            formatCurrency:moeda,calcularVariacao:()=> '0%',calcularVariacaoReverse:()=> '0%',calcularVariacaoSemBola:()=> '0%',
            sendWhatsappText:async(_t,text)=>enviados.push(text),sendWhatsappPdf:async()=>{},
            callPHP:async(method)=> {
                if(method==='getIntervalosSemanais') return periodos;
                if(method==='generateResumoFinanceiroPorGrupo') return {success:true,data:[resumo('100'),resumo('200',{estatisticas_pendentes:1})]};
                if(method==='generateNotasPorGrupo') return {success:true,data:[]};
                if(method==='gerarPdfSemanalCompras') return {success:true,url:null};
                throw new Error(method);
            },
        },
    });
    await worker.enviarResumoSemanal({nome:'Teste',telefone:'ficticio'},{id:1,nome:'Teste'});
    assert.equal(enviados.length,1);
    assert.match(enviados[0],/300,00/);
    assert.match(enviados[0],/Faturamento provisório/);
});

test('resumo semanal não transforma erro de endpoint em mensagem zerada', async () => {
    let enviados=0;
    const worker=load('workers/WorkerReportPdfWeekly.js',{
        '../utils/utils':{callPHP:async method=>method==='getIntervalosSemanais'?periodos:{success:false,message:'Falha SQL'},sendWhatsappText:async()=>enviados++},
    });
    await assert.rejects(worker.enviarResumoSemanal({nome:'Teste',telefone:'ficticio'},{id:1,nome:'Teste'}),/resumo/);
    assert.equal(enviados,0);
});

function billingMocks(getZig, writes) {
    return {'../utils/utils':{
        getZig,
        callPHP:async(method,data)=> {
            if(method==='getUnitsIntegrationZigBilling') return [{system_unit_id:24,lojaId:'uuid-iryna',token_zig:'token-ficticio'}];
            writes.push({method,data});return {success:true};
        },
    }};
}

test('importação Zig envia ID interno e só grava depois de obter as estatísticas',async()=>{
    const writes=[];let consultas=0;
    const worker=load('workers/workerBillingZig.js',billingMocks(async(endpoint,_l,_i,_f,_t,options)=>{
        assert.equal(options.strict,true);consultas++;
        assert.equal(writes.length,0);
        if(endpoint==='faturamento') return [{paymentName:'PIX',value:'10000',paymentId:'pix',eventId:'evento',eventDate:'2026-10-04',lojaId:'uuid-iryna',redeId:'rede'},{paymentName:'BÔNUS',value:'200'}];
        if(endpoint==='saida-produtos') return [{discountValue:100,productName:'Gorjeta',unitValue:50}];
        return [{numberOfSeats:2}];
    },writes));
    await worker.processJobCaixaZig(1,'2026-10-04','2026-10-04');
    assert.equal(consultas,3);
    assert.equal(writes[0].method,'ZigRegisterBilling');
    assert.equal(writes[0].data.sales.length,1);
    assert.equal(writes[1].method,'ZigUpdateStatics');
    assert.equal(writes[1].data.system_unit_id,24);
    assert.equal(writes[1].data.descontos,3);
    assert.equal(writes[1].data.gorjeta,0.5);
    assert.equal(writes[1].data.total_clientes,2);
});

for(const falhaEm of ['faturamento','tables']) {
    test(`erro Zig em ${falhaEm} preserva dados já importados`,async()=>{
        const writes=[];
        const worker=load('workers/workerBillingZig.js',billingMocks(async endpoint=>{
            if(endpoint===falhaEm) throw new Error('HTTP 403');
            return endpoint==='faturamento'?[{paymentName:'PIX',value:10000,paymentId:'pix',eventId:'evento',eventDate:'2026-10-04',lojaId:'uuid-iryna',redeId:'rede'}]:[];
        },writes));
        await assert.rejects(worker.processJobCaixaZig(1,'2026-10-04','2026-10-04'),/403/);
        assert.equal(writes.length,0);
    });
}

test('getZig estrito distingue HTTP 403 de uma lista realmente vazia',async()=>{
    const utils=load('utils/utils.js',{
        axios:{get:async()=>{const e=new Error('403');e.response={status:403,data:{error:'Forbidden'}};throw e;}},
        '../utils/apiLogger':{appendApiLog(){}},
        '@mrksolucoes/observability':{getLogger:()=>({})},
    });
    await assert.rejects(utils.getZig('faturamento','loja','2026-10-04','2026-10-04','ficticio',{strict:true}),/403/);
    assert.deepEqual(Array.from(await utils.getZig('faturamento','loja','2026-10-04','2026-10-04','ficticio')),[]);
});

test('pagamento Zig incompleto e data inválida não provocam escrita',async()=>{
    const writes=[];
    const worker=load('workers/workerBillingZig.js',billingMocks(async()=>[{value:10000,paymentName:'PIX'}],writes));
    await assert.rejects(worker.processJobCaixaZig(1,'2026-10-04','2026-10-04'),/Pagamento Zig sem/);
    await assert.rejects(worker.processJobCaixaZig(1,'2026-02-30','2026-03-01'),/Período Zig inválido/);
    assert.equal(writes.length,0);
});
