const Firebird = require('node-firebird');

const options = {
    host: '127.0.0.1',
    port: 3050,
    database: '/data/netuno.fdb',
    user: 'SYSDBA',
    password: 'masterkey',
    lowercase_keys: false
};

const tabelasAlvo = [
    'TABCABCONTA',
    'TBDETCONTA',
    'TBPAGCONTA',
    'TBNFCE',
    'TBNFCE_ITENS',
    'TBNFCE_PAG',
    'TBESTABELEICMENTO',
    'TBESTABELECIMENTO', // variação comum de escrita
    'TBMOV',
    'TBFECHA',
    'TBOPE'
];

console.log('Tentando conectar ao banco Firebird em:', options.database);

Firebird.attach(options, function(err, db) {
    if (err) {
        console.error('❌ Erro ao conectar ao Firebird:', err.message);
        console.log('\nComo instalar e rodar o Firebird no seu Mac via Homebrew:');
        console.log('  1. brew install firebird');
        console.log('  2. brew services start firebird');
        process.exit(1);
    }

    console.log('✅ Conexão estabelecida com sucesso!');
    console.log('Iniciando análise das tabelas do Menew...\n');

    // Executa análise sequencial das tabelas
    analisarProximaTabela(db, 0);
});

function analisarProximaTabela(db, index) {
    if (index >= tabelasAlvo.length) {
        console.log('\n=== Análise de Tabelas Concluída ===');
        db.detach();
        console.log('Conexão fechada.');
        return;
    }

    const tabela = tabelasAlvo[index];

    // 1. Verifica se a tabela existe no banco
    const checkSql = `SELECT COUNT(*) AS QTD FROM RDB$RELATIONS WHERE RDB$RELATION_NAME = '${tabela}'`;
    
    db.query(checkSql, function(err, rows) {
        if (err || rows.length === 0 || rows[0].QTD === 0) {
            // Tabela não existe, tenta a próxima
            analisarProximaTabela(db, index + 1);
            return;
        }

        console.log(`\n==================================================`);
        console.log(`📋 TABELA: ${tabela}`);
        console.log(`==================================================`);

        // 2. Conta registros na tabela
        db.query(`SELECT COUNT(*) AS TOTAL FROM ${tabela}`, function(err, countRows) {
            const totalRegistros = err ? 'Erro ao contar' : countRows[0].TOTAL;
            console.log(`Total de registros gravados: ${totalRegistros}`);

            // 3. Busca a estrutura de colunas (Metadata)
            const metaSql = `
                SELECT 
                    TRIM(R.RDB$FIELD_NAME) AS COLUNA,
                    F.RDB$FIELD_TYPE AS TIPO_ID,
                    F.RDB$FIELD_LENGTH AS TAMANHO
                FROM RDB$RELATION_FIELDS R
                JOIN RDB$FIELDS F ON R.RDB$FIELD_SOURCE = F.RDB$FIELD_NAME
                WHERE R.RDB$RELATION_NAME = '${tabela}'
                ORDER BY R.RDB$FIELD_POSITION
            `;

            db.query(metaSql, function(err, metaRows) {
                if (!err && metaRows.length > 0) {
                    console.log('\nEstrutura de Colunas:');
                    const colunas = metaRows.map(r => {
                        const tipo = getTipoFirebird(r.TIPO_ID);
                        return `  - ${r.COLUNA} (${tipo}${r.TAMANHO ? '[' + r.TAMANHO + ']' : ''})`;
                    });
                    console.log(colunas.join('\n'));
                }

                // 4. Pega uma amostra de 3 registros
                db.query(`SELECT FIRST 3 * FROM ${tabela}`, function(err, sampleRows) {
                    if (!err && sampleRows.length > 0) {
                        console.log('\nAmostra de Dados (Primeiros 3 registros):');
                        console.log(JSON.stringify(sampleRows, null, 2));
                    } else if (err) {
                        console.log('\n❌ Erro ao buscar amostra de dados:', err.message);
                    } else {
                        console.log('\nTabela vazia (sem registros).');
                    }

                    // Avança para a próxima tabela
                    analisarProximaTabela(db, index + 1);
                });
            });
        });
    });
}

function getTipoFirebird(typeId) {
    switch (typeId) {
        case 7: return 'SMALLINT';
        case 8: return 'INTEGER';
        case 10: return 'FLOAT';
        case 12: return 'DATE';
        case 13: return 'TIME';
        case 14: return 'CHAR';
        case 16: return 'BIGINT/NUMERIC';
        case 27: return 'DOUBLE';
        case 35: return 'TIMESTAMP';
        case 37: return 'VARCHAR';
        case 261: return 'BLOB';
        default: return `UNKNOWN (${typeId})`;
    }
}
