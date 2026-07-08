const { getConnection } = require('./utils/utils');

async function run() {
    let conn = null;
    try {
        conn = await getConnection();
        
        console.log('\n=== DESCRIBE TABLE products ===');
        const [prodCols] = await conn.execute('DESCRIBE products');
        console.log(prodCols.map(c => `- ${c.Field} (${c.Type}) | Null: ${c.Null} | Default: ${c.Default}`));

        console.log('\n=== DESCRIBE TABLE categorias ===');
        const [catCols] = await conn.execute('DESCRIBE categorias');
        console.log(catCols.map(c => `- ${c.Field} (${c.Type}) | Null: ${c.Null} | Default: ${c.Default}`));

        conn.end();
    } catch (err) {
        console.error('Erro ao fazer describe:', err);
        if (conn) conn.end();
    }
}

run();
