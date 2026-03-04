import { Redis } from '@upstash/redis';

export default async function handler(req, res) {
    const BOT_TOKEN = process.env.TELEGRAM_TOKEN;
    const ADMIN_ID = process.env.TELEGRAM_CHAT_ID;

    const redis = new Redis({
        url: process.env.KV_REST_API_URL || process.env.REDIS_URL,
        token: process.env.KV_REST_API_TOKEN || process.env.REDIS_REST_API_TOKEN,
    });

    if (req.body && req.body.message) {
        const msg = req.body.message.text;
        const chatId = req.body.message.chat.id;
        const isAdmin = String(chatId) === String(ADMIN_ID);
        if (!msg) return res.status(200).send('ok');

        const estado = await redis.get(`estado:${chatId}`);

        // 1. GESTIÓN DE RESPUESTAS (INTERCOMUNICADOR)
        if (estado && estado.startsWith('respondiendo:')) {
            const depto = estado.split(':')[1];
            await redis.set(`respuesta:${depto}`, msg, { ex: 120 });
            await redis.del(`estado:${chatId}`);
            await enviarMensaje(BOT_TOKEN, chatId, `✅ Enviado al interno ${depto}: "${msg}"`);
            return res.status(200).send('ok');
        }

        // 2. GESTIÓN DE ALTA (PASOS)
        if (estado === "esperando_depto") {
            const depto = msg.toUpperCase().trim();
            await redis.set(`estado:${chatId}`, `esperando_pass:${depto}`, { ex: 300 });
            const existe = await redis.get(`pass:${depto}`);
            await enviarMensaje(BOT_TOKEN, chatId, existe ? `🔐 El interno ${depto} ya existe. Escribí la clave:` : `🆕 El interno ${depto} es nuevo. Inventá una clave:`);
            return res.status(200).send('ok');
        }

        if (estado && estado.startsWith('esperando_pass:')) {
            const depto = estado.split(':')[1];
            const passGuardada = await redis.get(`pass:${depto}`);
            if (passGuardada && passGuardada !== msg.trim()) {
                await enviarMensaje(BOT_TOKEN, chatId, "🚫 Clave incorrecta. Proceso cancelado.");
                await redis.del(`estado:${chatId}`);
                return res.status(200).send('ok');
            }
            if (!passGuardada) await redis.set(`pass:${depto}`, msg.trim());
            let ows = await redis.get(`owners:${depto}`) || [];
            if (!ows.includes(chatId)) { ows.push(chatId); await redis.set(`owners:${depto}`, ows); }
            let lista = await redis.get('lista_deptos') || [];
            if (!lista.includes(depto)) { lista.push(depto); await redis.set('lista_deptos', lista.sort()); }
            await redis.del(`estado:${chatId}`);
            await enviarMensaje(BOT_TOKEN, chatId, `✅ ¡Listo! Ya estás registrado en el interno ${depto}.`);
            return res.status(200).send('ok');
        }

        // 3. COMANDOS DE BOTONES
        if (msg === "🏠 Registrarme") {
            await redis.set(`estado:${chatId}`, "esperando_depto", { ex: 60 });
            await enviarMensaje(BOT_TOKEN, chatId, "Escribí el nombre del interno (Ej: `1A`):");
            return res.status(200).send('ok');
        }

        if (msg === "📋 Ver Lista (Claves)" && isAdmin) {
            const lista = await redis.get('lista_deptos') || [];
            let txt = "📋 **Internos Registrados:**\n\n";
            for (const d of lista) {
                const p = await redis.get(`pass:${d}`);
                const ow = await redis.get(`owners:${d}`) || [];
                txt += `🏠 **${d}** | 🔑 \`${p}\` | 👥 ${ow.length}\n`;
            }
            await enviarMensaje(BOT_TOKEN, chatId, lista.length ? txt : "No hay nadie registrado.");
            return res.status(200).send('ok');
        }

        if (msg === "📜 Ver Logs (48h)" && isAdmin) {
            const logs = await redis.lrange('timbre_logs', 0, 19) || [];
            await enviarMensaje(BOT_TOKEN, chatId, logs.length ? "📜 **Últimos movimientos:**\n\n" + logs.join('\n') : "Sin actividad reciente.");
            return res.status(200).send('ok');
        }

        if (msg === "🗑️ Darme de Baja" || (msg === "🚨 Borrar Cualquier Interno" && isAdmin)) {
            const lista = await redis.get('lista_deptos') || [];
            let btns = [];
            for (const d of lista) {
                const ows = await redis.get(`owners:${d}`) || [];
                if (isAdmin || ows.includes(chatId)) {
                    btns.push([{ text: isAdmin ? `🚨 ELIMINAR ${d}` : `Salir de ${d}`, callback_data: `borrar_${d}` }]);
                }
            }
            if (btns.length === 0) return enviarMensaje(BOT_TOKEN, chatId, "No hay internos para mostrar.");
            await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ 
                    chat_id: chatId, 
                    text: "Seleccioná el interno:", 
                    reply_markup: { inline_keyboard: btns }
                })
            });
            return res.status(200).send('ok');
        }

        // 4. MENÚ POR DEFECTO (Si nada de lo anterior coincide)
        const tecladoAdmin = [
            [{ text: "🏠 Registrarme" }, { text: "🗑️ Darme de Baja" }],
            [{ text: "📋 Ver Lista (Claves)" }, { text: "🚨 Borrar Cualquier Interno" }],
            [{ text: "📜 Ver Logs (48h)" }]
        ];
        const tecladoVecino = [
            [{ text: "🏠 Registrarme" }, { text: "🗑️ Darme de Baja" }]
        ];

        await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                chat_id: chatId,
                text: isAdmin ? "👑 **Panel Admin**\n¿Qué necesitás, Agustín?" : "👋 **Timbre Digital**\nSeleccioná una opción:",
                parse_mode: 'Markdown',
                reply_markup: {
                    keyboard: isAdmin ? tecladoAdmin : tecladoVecino,
                    resize_keyboard: true,
                    one_time_keyboard: false
                }
            })
        });
        return res.status(200).send('ok');
    }

    // --- CALLBACKS (BOTONES AZULES) ---
    if (req.body && req.body.callback_query) {
        const data = req.body.callback_query.data;
        const chatId = req.body.callback_query.message.chat.id;
        const isAdmin = String(chatId) === String(ADMIN_ID);

        if (data.startsWith('rsp_')) {
            const depto = data.replace('rsp_', '');
            await redis.set(`estado:${chatId}`, `respondiendo:${depto}`, { ex: 120 });
            await enviarMensaje(BOT_TOKEN, chatId, `✍️ Escribí tu respuesta para el interno ${depto}:`);
        }

        if (data.startsWith('borrar_')) {
            const depto = data.replace('borrar_', '');
            if (isAdmin) {
                await redis.del(`owners:${depto}`, `pass:${depto}`, `respuesta:${depto}`);
                let lista = await redis.get('lista_deptos') || [];
                await redis.set('lista_deptos', lista.filter(i => i !== depto));
            } else {
                let ows = await redis.get(`owners:${depto}`) || [];
                await redis.set(`owners:${depto}`, ows.filter(id => id !== chatId));
            }
            await enviarMensaje(BOT_TOKEN, chatId, `🗑️ Se eliminó el registro de ${depto}.`);
        }
        return res.status(200).send('ok');
    }

    // --- LÓGICA WEB (TIMBRE) ---
    const { depto, msg, check } = req.query;
    if (!depto) return res.status(200).json(await redis.get('lista_deptos') || []);

    if (check) {
        const r = await redis.get(`respuesta:${depto}`);
        return res.status(200).json({ msj: r });
    }

    const fecha = new Date().toLocaleString("es-AR", { timeZone: "America/Argentina/Buenos_Aires" });
    const logEntry = `🕒 [${fecha.split(' ')[1]}] - Interno ${depto}`;
    await redis.lpush('timbre_logs', logEntry);
    await redis.ltrim('timbre_logs', 0, 50);
    await redis.expire('timbre_logs', 172800);

    const owners = await redis.get(`owners:${depto}`) || [];
    for (const id of owners) {
        await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                chat_id: id, 
                text: `🔔 **¡TIMBRE EN EL INTERNO ${depto}!**${msg ? `\n📝 _"${msg}"_` : ''}`,
                parse_mode: 'Markdown',
                reply_markup: { inline_keyboard: [[{ text: "💬 Responder", callback_data: `rsp_${depto}` }]] }
            })
        });
    }
    return res.status(200).send("ok");
}

async function enviarMensaje(token, chat, texto) {
    return fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: chat, text: texto, parse_mode: 'Markdown' })
    });
}
