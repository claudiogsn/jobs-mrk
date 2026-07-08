const { getConnection } = require('./utils/utils');

async function run() {
    let conn = null;
    try {
        conn = await getConnection();
        console.log('Conectando ao banco para verificar a notificação 7...');

        const [rows] = await conn.execute("SELECT * FROM system_notification WHERE id = 7");
        console.log('Dados da Notificação ID 7:', rows);

        conn.end();
    } catch (err) {
        console.error('Erro:', err);
        if (conn) conn.end();
    }
}

run();
