const { getConnection } = require('./utils/utils');

async function run() {
    let conn = null;
    try {
        conn = await getConnection();
        console.log('Conectado ao banco para ajustar destinatários de notificações antigas...');

        // 1. Lista usuários cadastrados para vermos quem é quem
        const [users] = await conn.execute("SELECT id, login, name FROM system_user");
        console.log('Usuários cadastrados no banco:', users);

        // Identifica o ID do Claudio Gomes ou do Admin (normalmente 1 ou 2)
        const claudio = users.find(u => u.login.includes('claudio') || u.name.includes('Claudio'));
        const targetUserId = claudio ? claudio.id : 1;
        console.log(`Definindo destinatário padrão das notificações antigas para o ID: ${targetUserId}`);

        // 2. Atualiza notificações órfãs
        const [result] = await conn.execute(
            "UPDATE system_notification SET system_user_to_id = ? WHERE system_user_to_id IS NULL OR system_user_to_id = 0",
            [targetUserId]
        );

        console.log(`Total de notificações antigas corrigidas no banco: ${result.affectedRows}`);
        conn.end();
    } catch (err) {
        console.error('Erro ao ajustar notificações:', err);
        if (conn) conn.end();
    }
}

run();
