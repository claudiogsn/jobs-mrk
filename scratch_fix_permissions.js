const { getConnection } = require('./utils/utils');

async function run() {
    let conn = null;
    try {
        conn = await getConnection();
        console.log('Conectado ao banco de dados para ajustar permissões...');

        // 1. Garante que os programas estão cadastrados na system_program
        const programsToCheck = [
            { name: 'System Notification List', controller: 'SystemNotificationList' },
            { name: 'System Notification Form View', controller: 'SystemNotificationFormView' }
        ];

        for (const prog of programsToCheck) {
            const [rows] = await conn.execute(
                "SELECT id FROM system_program WHERE controller = ?",
                [prog.controller]
            );

            let programId;
            if (rows.length === 0) {
                const [[maxProgRow]] = await conn.execute("SELECT COALESCE(MAX(id), 0) + 1 AS nextId FROM system_program");
                programId = maxProgRow.nextId;
                await conn.execute(
                    "INSERT INTO system_program (id, name, controller) VALUES (?, ?, ?)",
                    [programId, prog.name, prog.controller]
                );
                console.log(`Program ${prog.controller} criado com ID ${programId}`);
            } else {
                programId = rows[0].id;
                console.log(`Program ${prog.controller} já existe com ID ${programId}`);
            }

            // 2. Garante que todos os grupos de usuário cadastrados tenham permissão para estes programas
            const [groups] = await conn.execute("SELECT id, name FROM system_group");
            for (const grp of groups) {
                const [grpProg] = await conn.execute(
                    "SELECT id FROM system_group_program WHERE system_group_id = ? AND system_program_id = ?",
                    [grp.id, programId]
                );

                if (grpProg.length === 0) {
                    const [[maxGrpProgRow]] = await conn.execute("SELECT COALESCE(MAX(id), 0) + 1 AS nextId FROM system_group_program");
                    const nextGrpProgId = maxGrpProgRow.nextId;
                    await conn.execute(
                        "INSERT INTO system_group_program (id, system_group_id, system_program_id) VALUES (?, ?, ?)",
                        [nextGrpProgId, grp.id, programId]
                    );
                    console.log(`Permissão adicionada: Grupo "${grp.name}" -> Programa "${prog.controller}"`);
                } else {
                    console.log(`Grupo "${grp.name}" já possui permissão para "${prog.controller}"`);
                }
            }
        }

        console.log('Permissões de notificação ajustadas com sucesso!');
        conn.end();
    } catch (err) {
        console.error('Erro ao ajustar permissões:', err);
        if (conn) conn.end();
    }
}

run();
