import { Redis } from '@upstash/redis';

export default async function handler(req, res) {
    const BOT_TOKEN = process.env.TELEGRAM_TOKEN;
    const ADMIN_ID = process.env.TELEGRAM_CHAT_ID;
    const AUDIO_ID = process.env.AUDIO_FILE_ID;

    const redis = new Redis({
        url: process.env.KV_REST_API_URL || process.env.REDIS_URL,
        token: process.env.KV_REST_API_TOKEN || process.env.REDIS_REST_API_TOKEN,
    });

    // --- 1. GESTIÓN DE MENSAJES ENTRANTES ---
    if (req.body && req.body.message) {
        const msg = req.body.message.text;
        const chatId = req.body.message.chat.id;
        const isAdmin = String(chatId) === String(ADMIN_ID);

        if (!msg) return res.status(200).send('ok');
        const estado = await redis.get(`estado:${chatId}`);

        // Lógica de respuesta (Intercomunicador)
        if (estado && estado.startsWith('respondiendo:')) {
            const depto = estado.split(':')[1];
            await redis.set(`respuesta:${depto}`, msg, { ex: 120 });
            await redis.del(`estado:${chatId}`);
            await enviarMensaje(BOT_TOKEN, chatId, `✅ Enviado al interno ${depto}: "${msg}"`);
            return res.status(200).send('ok');
        }

        // Lógica de Registro (Deptos y Claves)
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

        // Menú Principal (Botones Inline para PC y Mobile)
        const botones = [
            [{ text: "🏠 Registrarme", callback_data: "m_reg" }, { text: "🗑️ Darme de Baja", callback_data: "m_baja" }],
            [{ text: "🎵 Sonido de Timbre", callback_data: "m_audio" }]
        ];
        if (isAdmin) {
            botones.push([{ text: "📋 Ver Lista", callback_data: "m_lista" }, { text: "📜 Ver Logs", callback_data: "m_logs" }]);
        }

        await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                chat_id: chatId,
                text: isAdmin ? "👑 **Panel Admin**" : "👋 **Timbre Digital**\nSeleccioná una opción:",
                parse_mode: 'Markdown',
                reply_markup: { inline_keyboard: botones }
            })
        });
        return res.status(200).send('ok');
    }

    // --- 2. GESTIÓN DE CALLBACKS (BOTONES) ---
    if (req.body && req.body.callback_query) {
        const data = req.body.callback_query.data;
        const chatId = req.body.callback_query.message.chat.id;
        const isAdmin = String(chatId) === String(ADMIN_ID);

        if (data === "m_reg") {
            await redis.set(`estado:${chatId}`, "esperando_depto", { ex: 60 });
            await enviarMensaje(BOT_TOKEN, chatId, "Escribí el nombre del interno (Ej: `1A`):");
        } 
        else if (data === "m_audio") {
            if (!AUDIO_ID) return enviarMensaje(BOT_TOKEN, chatId, "❌ Error: Audio no configurado en Vercel.");
            await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendAudio`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    chat_id: chatId,
                    audio: AUDIO_ID,
                    caption: "🔔 Descargá este audio y configuralo como sonido personalizado para este chat."
                })
            });
        }
        else if (data === "m_lista" && isAdmin) {
            const lista = await redis.get('lista_deptos') || [];
            let txt = "📋 **Internos Registrados:**\n\n";
            for (const d of lista) {
                const p = await redis.get(`pass:${d}`);
                txt += `🏠 **${d}** | 🔑 \`${p}\` \n`;
            }
            await enviarMensaje(BOT_TOKEN, chatId, lista.length ? txt : "No hay registros.");
        }
        else if (data === "m_logs" && isAdmin) {
            const logs = await redis.lrange('timbre_logs', 0, 19) || [];
            await enviarMensaje(BOT_TOKEN, chatId, logs.length ? "📜 **Logs:**\n\n" + logs.join('\n') : "Sin actividad.");
        }
        else if (data === "m_baja") {
            const lista = await redis.get('lista_deptos') || [];
            let btns = [];
            for (const d of lista) {
                const ows = await redis.get(`owners:${d}`) || [];
                if (isAdmin || ows.includes(chatId)) {
                    btns.push([{ text: isAdmin ? `🚨 BORRAR ${d}` : `Salir de ${d}`, callback_data: `borrar_${d}` }]);
                }
            }
            await enviarMensaje(BOT_TOKEN, chatId, btns.length ? "Seleccioná la unidad:" : "No tenés unidades registradas.", { inline_keyboard: btns });
        }

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

    // --- 3. LÓGICA WEB (PETICIÓN DESDE EL TIMBRE) ---
    const { depto, msg, check } = req.query;
    if (!depto) return res.status(200).json(await redis.get('lista_deptos') || []);

    if (check) {
        const r = await redis.get(`respuesta:${depto}`);
        return res.status(200).json({ msj: r });
    }

    // Guardar Log
    const fecha = new Date().toLocaleString("es-AR", { timeZone: "America/Argentina/Buenos_Aires" });
    const logEntry = `🕒 [${fecha.split(' ')[1]}] - Interno ${depto}`;
    await redis.lpush('timbre_logs', logEntry);
    await redis.ltrim('timbre_logs', 0, 50);

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

async function enviarMensaje(token, chat, texto, markup = null) {
    const body = { chat_id: chat, text: texto, parse_mode: 'Markdown' };
    if (markup) body.reply_markup = markup;
    return fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
    });
}
