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

        // CASO: Respondiendo al timbre
        if (estado && estado.startsWith('respondiendo:')) {
            const depto = estado.split(':')[1];
            await redis.set(`respuesta:${depto}`, msg, { ex: 120 });
            await redis.del(`estado:${chatId}`);
            await enviarMensaje(BOT_TOKEN, chatId, `✅ Enviado: "${msg}"`);
            return res.status(200).send('ok');
        }

        // CASO: Alta amigable (Contraseña)
        if (estado && estado.startsWith('esperando_pass:')) {
            const depto = estado.split(':')[1];
            const passGuardada = await redis.get(`pass:${depto}`);
            if (passGuardada && passGuardada !== msg.trim()) {
                await enviarMensaje(BOT_TOKEN, chatId, "🚫 Clave incorrecta.");
                await redis.del(`estado:${chatId}`);
                return res.status(200).send('ok');
            }
            if (!passGuardada) await redis.set(`pass:${depto}`, msg.trim());
            let ows = await redis.get(`owners:${depto}`) || [];
            if (!ows.includes(chatId)) { ows.push(chatId); await redis.set(`owners:${depto}`, ows); }
            let lista = await redis.get('lista_deptos') || [];
            if (!lista.includes(depto)) { lista.push(depto); await redis.set('lista_deptos', lista.sort()); }
            await redis.del(`estado:${chatId}`);
            await enviarMensaje(BOT_TOKEN, chatId, `✅ Registrado en ${depto}.`);
            return res.status(200).send('ok');
        }

        // MENÚ PRINCIPAL
        if (msg === '/start' || msg === 'Hola' || msg === 'Menu') {
            const teclado = [[{ text: "🏠 Registrarme" }, { text: "🗑️ Darme de Baja" }]];
            if (isAdmin) {
                teclado.push([{ text: "📋 Ver Lista (Claves)" }, { text: "🚨 Borrar Cualquier Interno" }]);
                teclado.push([{ text: "📜 Ver Logs (48h)" }]); // NUEVO BOTÓN
            }
            await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    chat_id: chatId,
                    text: isAdmin ? "👑 **Panel Admin**" : "👋 **Timbre Digital**",
                    reply_markup: { keyboard: teclado, resize_keyboard: true }
                })
            });
            return res.status(200).send('ok');
        }

        // ACCIÓN: REGISTRARME
        if (msg === "🏠 Registrarme") {
            await enviarMensaje(BOT_TOKEN, chatId, "Escribí el nombre del interno (Ej: `1A`):");
            await redis.set(`estado:${chatId}`, "esperando_depto", { ex: 60 });
            return res.status(200).send('ok');
        }

        if (estado === "esperando_depto") {
            const depto = msg.toUpperCase().trim();
            await redis.set(`estado:${chatId}`, `esperando_pass:${depto}`, { ex: 300 });
            const existe = await redis.get(`pass:${depto}`);
            await enviarMensaje(BOT_TOKEN, chatId, existe ? `🔐 Clave para ${depto}:` : `🆕 Inventá clave para ${depto}:`);
            return res.status(200).send('ok');
        }

        // ACCIÓN: LOGS (SOLO ADMIN)
        if (msg === "📜 Ver Logs (48h)" && isAdmin) {
            const logs = await redis.lrange('timbre_logs', 0, 19) || [];
            if (logs.length === 0) return enviarMensaje(BOT_TOKEN, chatId, "No hay registros recientes.");
            await enviarMensaje(BOT_TOKEN, chatId, "📜 **Últimos 20 toques de timbre:**\n\n" + logs.join('\n'));
            return res.status(200).send('ok');
        }

        // ACCIÓN: LISTA (SOLO ADMIN)
        if (msg === "📋 Ver Lista (Claves)" && isAdmin) {
            const lista = await redis.get('lista_deptos') || [];
            let txt = "📋 **Internos:**\n\n";
            for (const d of lista) {
                const p = await redis.get(`pass:${d}`);
                const ow = await redis.get(`owners:${d}`) || [];
                txt += `🏠 **${d}** | 🔑 \`${p}\` | 👥 ${ow.length}\n`;
            }
            await enviarMensaje(BOT_TOKEN, chatId, txt);
            return res.status(200).send('ok');
        }

        // ACCIÓN: BAJA
        if (msg === "🗑️ Darme de Baja" || (msg === "🚨 Borrar Cualquier Interno" && isAdmin)) {
            const lista = await redis.get('lista_deptos') || [];
            let btns = [];
            for (const d of lista) {
                const ows = await redis.get(`owners:${d}`) || [];
                if (isAdmin || ows.includes(chatId)) {
                    btns.push([{ text: isAdmin ? `🚨 BORRAR ${d}` : `Salir de ${d}`, callback_data: `borrar_${d}` }]);
                }
            }
            if (btns.length === 0) return enviarMensaje(BOT_TOKEN, chatId, "Sin internos.");
            await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ chat_id: chatId, text: "Seleccioná:", reply_markup: { inline_keyboard: btns }})
            });
            return res.status(200).send('ok');
        }
    }

    // --- CALLBACKS ---
    if (req.body && req.body.callback_query) {
        const data = req.body.callback_query.data;
        const chatId = req.body.callback_query.message.chat.id;
        if (data.startsWith('rsp_')) {
            const depto = data.replace('rsp_', '');
            await redis.set(`estado:${chatId}`, `respondiendo:${depto}`, { ex: 120 });
            await enviarMensaje(BOT_TOKEN, chatId, `✍️ Respuesta para ${depto}:`);
        }
        if (data.startsWith('borrar_')) {
            const depto = data.replace('borrar_', '');
            if (String(chatId) === String(ADMIN_ID)) {
                await redis.del(`owners:${depto}`, `pass:${depto}`, `respuesta:${depto}`);
                let lista = await redis.get('lista_deptos') || [];
                await redis.set('lista_deptos', lista.filter(i => i !== depto));
            } else {
                let ows = await redis.get(`owners:${depto}`) || [];
                await redis.set(`owners:${depto}`, ows.filter(id => id !== chatId));
            }
            await enviarMensaje(BOT_TOKEN, chatId, "Eliminado.");
        }
        return res.status(200).send('ok');
    }

    // --- LÓGICA WEB ---
    const { depto, msg, check } = req.query;
    if (!depto) return res.status(200).json(await redis.get('lista_deptos') || []);

    if (check) {
        const r = await redis.get(`respuesta:${depto}`);
        return res.status(200).json({ msj: r });
    }

    // GUARDAR LOG (Con hora Argentina aprox)
    const fecha = new Date().toLocaleString("es-AR", { timeZone: "America/Argentina/Buenos_Aires" });
    const logEntry = `🕒 [${fecha.split(' ')[1]}] - Interno ${depto}`;
    await redis.lpush('timbre_logs', logEntry);
    await redis.ltrim('timbre_logs', 0, 50); // Guardamos solo los últimos 50 para no saturar
    await redis.expire('timbre_logs', 172800); // Borrar todo el historial cada 48 horas (172800 seg)

    const owners = await redis.get(`owners:${depto}`) || [];
    for (const id of owners) {
        await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                chat_id: id, text: `🔔 **¡TIMBRE EN EL INTERNO ${depto}!**${msg ? `\n📝 _"${msg}"_` : ''}`,
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
