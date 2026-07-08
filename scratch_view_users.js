const { getConnection } = require('./utils/utils');

async function run() {
    let conn = null;
    try {
        conn = await getConnection();
        console.log('Conectando ao banco para verificar os usuários na system_users...');

        const [rows] = await conn.execute("SELECT id, login, name FROM system_users");
        console.log('Usuários:', rows);

        conn.end();
    } catch (err) {
        console.error('Erro:', err);
        if (conn) conn.end();
    }
}

run();
