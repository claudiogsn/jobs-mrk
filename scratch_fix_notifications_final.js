const { getConnection } = require('./utils/utils');

async function run() {
    let conn = null;
    try {
        conn = await getConnection();
        console.log('Conectado ao banco para corrigir as notificações órfãs antigas...');

        // Atualiza o destinatário (system_user_to_id) para 1 (Admin/Claudio)
        const [res1] = await conn.execute(
            "UPDATE system_notification SET system_user_to_id = 1 WHERE system_user_to_id IS NULL OR system_user_to_id = 0"
        );
        console.log(`Corrigidas system_user_to_id: ${res1.affectedRows} linhas.`);

        // Atualiza o remetente (system_user_id) para 1 (Admin) caso esteja vazio
        const [res2] = await conn.execute(
            "UPDATE system_notification SET system_user_id = 1 WHERE system_user_id IS NULL OR system_user_id = 0"
        );
        console.log(`Corrigidas system_user_id: ${res2.affectedRows} linhas.`);

        conn.end();
        console.log('Notificações corrigidas com sucesso no banco!');
    } catch (err) {
        console.error('Erro na correção das notificações:', err);
        if (conn) conn.end();
    }
}

run();
