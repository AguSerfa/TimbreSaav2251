import { Redis } from '@upstash/redis';

export default async function handler(req, res) {
    const BOT_TOKEN = process.env.TELEGRAM_TOKEN;
    const ADMIN_ID = process.env.TELEGRAM_CHAT_ID;
    const AUDIO_ID = process.env.AUDIO_FILE_ID;

    const redis = new Redis({
        url: process.env.KV_REST_API_URL || process.env.REDIS_URL,
        token: process.env.KV_REST_API_TOKEN || process.env.REDIS_REST_API_TOKEN,
    });

    // --- 1. LÓGICA DE ADMIN / LOGS (Vía Web) ---
    const { admin, depto, msg, check } = req.query;

    if (admin) {
        // Verificamos si el que pide es el admin (opcional: podés comparar con una clave o con tu ID)
        try {
            const logs = await redis.lrange('timbre_logs', 0, 30);
            return res.status(200).json(logs || []);
        } catch (e) {
            return res.status(500).json({ error: "Error al leer logs" });
        }
    }

    // --- 2. MENSAJES DE TELEGRAM (Webhook) ---
    if (req.body && req.body.message) {
        const msgTxt = req.body.message.text;
        const chatId = req.body.message.chat.id;
        const isAdmin = String(chatId) === String(ADMIN_ID);
        if (!msgTxt) return res.status(200).send('ok');

        const estado = await redis.get(`estado:${chatId}`);

        if (estado && estado.startsWith('respondiendo:')) {
            const d = estado.split(':')[1];
            await redis.set(`respuesta:${d}`, msgTxt, { ex: 90 });
            await redis.del(`estado:${chatId}`);
            await enviarMensaje(BOT_TOKEN, chatId, `✅ Enviado al interno ${d}: "${msgTxt}"`);
            return res.status(200).send('ok');
        }

        if (estado && estado.startsWith('esperando_pass:')) {
            const d = estado.split(':')[1];
            const passGuardada = await redis.get(`pass:${d}`);
            if (passGuardada && passGuardada !== msgTxt.trim()) {
                await enviarMensaje(BOT_TOKEN, chatId, "🚫 Clave incorrecta. Registro cancelado.");
                await redis.del(`estado:${chatId}`);
                return res.status(200).send('ok');
            }
            if (!passGuardada) await redis.set(`pass:${d}`, msgTxt.trim());
            
            let ows = await redis.get(`owners:${d}`) || [];
            if (!ows.includes(chatId)) { 
                ows.push(chatId); 
                await redis.set(`owners:${d}`, ows); 
            }

            let lista = await redis.get('lista_deptos') || [];
            if (!lista.includes(d)) { 
                lista.push(d); 
                lista.sort((a, b) => parseInt(a) - parseInt(b));
                await redis.set('lista_deptos', lista); 
            }

            await redis.del(`estado:${chatId}`);
            await enviarMensaje(BOT_TOKEN, chatId, `✅ ¡Listo! El interno ${d} ya está activo.`);
            return res.status(200).send('ok');
        }

        const botones = [
            [{ text: "🏠 Registrarme", callback_data: "m_reg" }, { text: "🗑️ Darme de Baja", callback_data: "m_baja" }],
            [{ text: "🎵 Sonido de Timbre", callback_data: "m_audio" }]
        ];
        if (isAdmin) {
            botones.push([{ text: "📋 Ver Lista", callback_data: "m_lista" }, { text: "📜 Ver Logs", callback_data: "m_logs" }]);
        }

        await enviarMensaje(BOT_TOKEN, chatId, isAdmin ? "👑 **Panel Admin**" : "👋 **Timbre Digital**", { inline_keyboard: botones });
        return res.status(200).send('ok');
    }

    // --- 3. CALLBACKS DE TELEGRAM ---
    if (req.body && req.body.callback_query) {
        const data = req.body.callback_query.data;
        const chatId = req.body.callback_query.message.chat.id;
        const isAdmin = String(chatId) === String(ADMIN_ID);

        if (data === "m_reg") {
            const filas = [];
            for (let i = 1; i <= 15; i += 3) {
                filas.push([
                    { text: `${i}`, callback_data: `reg_${i}` },
                    { text: `${i+1}`, callback_data: `reg_${i+1}` },
                    { text: `${i+2}`, callback_data: `reg_${i+2}` }
                ]);
            }
            await enviarMensaje(BOT_TOKEN, chatId, "🏠 **¿Interno?**", { inline_keyboard: filas });
        } 
        
        else if (data.startsWith('reg_')) {
            const d = data.replace('reg_', '');
            await redis.set(`estado:${chatId}`, `esperando_pass:${d}`, { ex: 300 });
            const existe = await redis.get(`pass:${d}`);
            await enviarMensaje(BOT_TOKEN, chatId, existe ? `🔐 Interno ${d} activo. Clave:` : `🆕 Interno ${d}. Inventá clave:`);
        }

        else if (data === "m_logs" && isAdmin) {
            const logs = await redis.lrange('timbre_logs', 0, 15);
            const txt = logs.length ? "📜 **Últimos logs:**\n" + logs.join('\n') : "No hay logs.";
            await enviarMensaje(BOT_TOKEN, chatId, txt);
        }

        else if (data === "m_lista" && isAdmin) {
            const lista = await redis.get('lista_deptos') || [];
            let txt = "📋 **Activos:**\n";
            for (const d of lista) {
                const p = await redis.get(`pass:${d}`);
                txt += `🏠 Int ${d} | Clave: \`${p}\` \n`;
            }
            await enviarMensaje(BOT_TOKEN, chatId, txt || "Vacío.");
        }

        if (data.startsWith('rsp_')) {
            const d = data.replace('rsp_', '');
            await redis.set(`estado:${chatId}`, `respondiendo:${d}`, { ex: 120 });
            await enviarMensaje(BOT_TOKEN, chatId, `✍️ Respuesta para el visitante:`);
        }

        if (data.startsWith('borrar_')) {
            const d = data.replace('borrar_', '');
            await redis.del(`owners:${d}`, `pass:${d}`, `respuesta:${d}`);
            let lista = await redis.get('lista_deptos') || [];
            await redis.set('lista_deptos', lista.filter(i => i !== d));
            await enviarMensaje(BOT_TOKEN, chatId, `🗑️ Borrado.`);
        }

        return res.status(200).send('ok');
    }

    // --- 4. LÓGICA WEB (Peticiones comunes) ---
    if (!depto) {
        const lista = await redis.get('lista_deptos') || [];
        return res.status(200).json(lista);
    }

    if (check) {
        const r = await redis.get(`respuesta:${depto}`);
        if (r) await redis.del(`respuesta:${depto}`);
        return res.status(200).json({ msj: r });
    }

    // CUANDO ALGUIEN TOCA EL TIMBRE:
    const fecha = new Date().toLocaleString("es-AR", { timeZone: "America/Argentina/Buenos_Aires" });
    const hora = fecha.split(', ')[1] || fecha;
    await redis.lpush('timbre_logs', `🕒 [${hora}] - Int. ${depto}`);
    await redis.ltrim('timbre_logs', 0, 30);

    const owners = await redis.get(`owners:${depto}`) || [];
    for (const id of owners) {
        await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                chat_id: id, 
                text: msg ? `💬 **Int. ${depto}:**\n_"${msg}"_` : `🔔 **¡Tocaron timbre en el Int. ${depto}!**`,
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
