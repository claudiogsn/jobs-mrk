require('dotenv').config();
const readline = require('readline');
const { getConnection } = require('../utils/utils');
const { run3lmExclusaoById } = require('../workers/worker3lmImport');
const { DateTime } = require('luxon');

const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
});

function askQuestion(query) {
    return new Promise(resolve => rl.question(query, resolve));
}

function formatBytes(bytes) {
    if (!bytes) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

function formatBRL(val) {
    return new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(val);
}

async function main() {
    let conn = null;
    try {
        conn = await getConnection();
        
        console.log('\n======================================================');
        console.log('🔍 Buscando importações recentes do 3LM...');
        console.log('======================================================\n');

        const [rows] = await conn.execute(`
            SELECT i.id, i.system_unit_id, u.name as unit_name, i.nome_arquivo, 
                   i.tamanho_arquivo, i.total_vendas, i.total_notas, i.status, 
                   i.created_at, i.data_inicio_faturamento, i.data_fim_faturamento
            FROM 3lm_imports i
            JOIN system_unit u ON i.system_unit_id = u.id
            ORDER BY i.id DESC
            LIMIT 30
        `);

        if (rows.length === 0) {
            console.log('⚠️ Nenhuma importação de 3LM encontrada.');
            rl.close();
            conn.end();
            return;
        }

        // Exibe a lista
        rows.forEach((imp, index) => {
            const num = index + 1;
            const dataEnvio = DateTime.fromJSDate(imp.created_at).setZone('America/Sao_Paulo').toFormat('dd/MM/yyyy HH:mm:ss');
            const dataInicio = imp.data_inicio_faturamento ? DateTime.fromJSDate(imp.data_inicio_faturamento).toFormat('dd/MM/yyyy') : null;
            const dataFim = imp.data_fim_faturamento ? DateTime.fromJSDate(imp.data_fim_faturamento).toFormat('dd/MM/yyyy') : null;
            const periodo = (dataInicio && dataFim) ? `${dataInicio} até ${dataFim}` : 'Aguardando...';
            
            const totalNotas = imp.total_notas > 0 ? imp.total_notas : '-';
            const totalVendas = imp.total_vendas > 0 ? formatBRL(parseFloat(imp.total_vendas)) : '-';
            
            // Colorindo o status para melhor experiência visual
            let statusColor = '\x1b[0m'; // Default
            if (imp.status === 'sucesso') statusColor = '\x1b[32m'; // Green
            else if (imp.status === 'processando') statusColor = '\x1b[34m'; // Blue
            else if (imp.status === 'erro') statusColor = '\x1b[31m'; // Red
            else if (imp.status === 'excluindo') statusColor = '\x1b[33m'; // Yellow
            
            console.log(`[\x1b[36m${num.toString().padStart(2, '0')}\x1b[0m] ID: \x1b[1m${imp.id}\x1b[0m | Loja: ${imp.unit_name} (ID: ${imp.system_unit_id})`);
            console.log(`     Arquivo: ${imp.nome_arquivo} (${formatBytes(imp.tamanho_arquivo)})`);
            console.log(`     Período: ${periodo} | Notas: ${totalNotas} | Total: ${totalVendas}`);
            console.log(`     Status: ${statusColor}${imp.status.toUpperCase()}\x1b[0m | Enviado em: ${dataEnvio}`);
            console.log('------------------------------------------------------');
        });

        const choice = await askQuestion('\n👉 Digite o número da opção que deseja excluir (ou "q" para sair): ');
        if (choice.trim().toLowerCase() === 'q') {
            console.log('👋 Operação cancelada. Saindo...');
            rl.close();
            conn.end();
            return;
        }

        const selectedIndex = parseInt(choice) - 1;
        if (isNaN(selectedIndex) || selectedIndex < 0 || selectedIndex >= rows.length) {
            console.log('❌ Opção inválida. Saindo...');
            rl.close();
            conn.end();
            return;
        }

        const selectedImport = rows[selectedIndex];

        // Confirmação
        const confirmation = await askQuestion(`\n⚠️  Você tem certeza que deseja excluir a importação #${selectedImport.id} (${selectedImport.nome_arquivo}) da loja "${selectedImport.unit_name}"? (s/n): `);
        
        if (confirmation.trim().toLowerCase() !== 's') {
            console.log('👋 Operação cancelada. Saindo...');
            rl.close();
            conn.end();
            return;
        }

        console.log(`\n⏳ Iniciando exclusão da importação #${selectedImport.id}... Por favor, aguarde.`);
        
        // Temporariamente redireciona logs para podermos ver as ações acontecendo em tempo real na CLI
        const loggerModule = require('../utils/logger');
        const originalLog = loggerModule.log;
        loggerModule.log = (message, workerName) => {
            console.log(`\x1b[90m[${workerName}]\x1b[0m ${message}`);
            originalLog(message, workerName);
        };

        // Atualiza status localmente para excluindo antes de rodar
        await conn.execute("UPDATE 3lm_imports SET status = 'excluindo' WHERE id = ?", [selectedImport.id]);

        // Executa a exclusão de forma síncrona/sequencial para a CLI
        await run3lmExclusaoById(selectedImport.id, selectedImport.system_unit_id);

        // Restaura o logger
        loggerModule.log = originalLog;

        console.log('\n\x1b[32m✔ Importação excluída com sucesso do banco de dados e arquivos removidos!\x1b[0m\n');

    } catch (err) {
        console.error('\n❌ Ocorreu um erro durante a execução da CLI:', err.message);
    } finally {
        rl.close();
        if (conn) {
            try {
                conn.end();
            } catch (_) {}
        }
    }
}

main();
