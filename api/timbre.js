import { Redis } from '@upstash/redis';

export default async function handler(req, res) {
    const BOT_TOKEN = process.env.TELEGRAM_TOKEN;
    const ADMIN_ID = process.env.TELEGRAM_CHAT_ID;
    const AUDIO_ID = process.env.AUDIO_FILE_ID;

    const redis = new Redis({
        url: process.env.KV_REST_API_URL || process.env.REDIS_URL,
        token: process.env.KV_REST_API_TOKEN || process.env.REDIS_REST_API_TOKEN,
    });

    // --- 1. MENSAJES DE TEXTO ---
    if (req.body && req.body.message) {
        const msg = req.body.message.text;
        const chatId = req.body.message.chat.id;
        const isAdmin = String(chatId) === String(ADMIN_ID);
        if (!msg) return res.status(200).send('ok');

        const estado = await redis.get(`estado:${chatId}`);

        // RESPUESTA DEL DUEÑO (Para que aparezca en la web)
        if (estado && estado.startsWith('respondiendo:')) {
            const depto = estado.split(':')[1];
            await redis.set(`respuesta:${depto}`, msg, { ex: 90 }); // La respuesta dura 90 seg en la web
            await redis.del(`estado:${chatId}`);
            await enviarMensaje(BOT_TOKEN, chatId, `✅ Enviado al interno ${depto}: "${msg}"`);
            return res.status(200).send('ok');
        }

        // REGISTRO PASO 2: RECIBIR CLAVE
        if (estado && estado.startsWith('esperando_pass:')) {
            const depto = estado.split(':')[1];
            const passGuardada = await redis.get(`pass:${depto}`);
            
            if (passGuardada && passGuardada !== msg.trim()) {
                await enviarMensaje(BOT_TOKEN, chatId, "🚫 Clave incorrecta. Registro cancelado.");
                await redis.del(`estado:${chatId}`);
                return res.status(200).send('ok');
            }

            // Si es nuevo o clave correcta, guardamos
            if (!passGuardada) await redis.set(`pass:${depto}`, msg.trim());
            
            let ows = await redis.get(`owners:${depto}`) || [];
            if (!ows.includes(chatId)) { 
                ows.push(chatId); 
                await redis.set(`owners:${depto}`, ows); 
            }

            // ACÁ ACTIVAMOS EL BOTÓN EN LA WEB
            let lista = await redis.get('lista_deptos') || [];
            if (!lista.includes(depto)) { 
                lista.push(depto); 
                // Ordenar numéricamente para la web
                lista.sort((a, b) => parseInt(a) - parseInt(b));
                await redis.set('lista_deptos', lista); 
            }

            await redis.del(`estado:${chatId}`);
            await enviarMensaje(BOT_TOKEN, chatId, `✅ ¡Listo! El interno ${depto} ya está activo en la web.`);
            return res.status(200).send('ok');
        }

        // MENÚ PRINCIPAL
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

    // --- 2. CALLBACKS (BOTONES) ---
    if (req.body && req.body.callback_query) {
        const data = req.body.callback_query.data;
        const chatId = req.body.callback_query.message.chat.id;
        const isAdmin = String(chatId) === String(ADMIN_ID);

        // REGISTRO PASO 1: ELEGIR DEL 1 AL 15
        if (data === "m_reg") {
            const filas = [];
            for (let i = 1; i <= 15; i += 3) {
                filas.push([
                    { text: `${i}`, callback_data: `reg_${i}` },
                    { text: `${i+1}`, callback_data: `reg_${i+1}` },
                    { text: `${i+2}`, callback_data: `reg_${i+2}` }
                ]);
            }
            await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    chat_id: chatId,
                    text: "🏠 **¿En qué número de interno vivís?**",
                    reply_markup: { inline_keyboard: filas }
                })
            });
        } 
        
        else if (data.startsWith('reg_')) {
            const depto = data.replace('reg_', '');
            await redis.set(`estado:${chatId}`, `esperando_pass:${depto}`, { ex: 300 });
            const existe = await redis.get(`pass:${depto}`);
            await enviarMensaje(BOT_TOKEN, chatId, existe ? `🔐 El interno ${depto} ya está activo. Escribí la clave para sumarte:` : `🆕 Vas a activar el interno ${depto}. Inventá una clave:`);
        }

        else if (data === "m_audio") {
            await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendAudio`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ chat_id: chatId, audio: AUDIO_ID, caption: "🔔 Sonido para notificaciones." })
            });
        }

        else if (data === "m_lista" && isAdmin) {
            const lista = await redis.get('lista_deptos') || [];
            let txt = "📋 **Internos Activos:**\n";
            for (const d of lista) {
                const p = await redis.get(`pass:${d}`);
                txt += `🏠 Interno ${d} | Clave: \`${p}\` \n`;
            }
            await enviarMensaje(BOT_TOKEN, chatId, txt || "No hay nadie registrado.");
        }

        else if (data === "m_baja") {
            const lista = await redis.get('lista_deptos') || [];
            let btns = [];
            for (const d of lista) {
                const ows = await redis.get(`owners:${d}`) || [];
                if (isAdmin || ows.includes(chatId)) {
                    btns.push([{ text: `Borrar Interno ${d}`, callback_data: `borrar_${d}` }]);
                }
            }
            await enviarMensaje(BOT_TOKEN, chatId, btns.length ? "Seleccioná para eliminar:" : "No tenés internos.", { inline_keyboard: btns });
        }

        if (data.startsWith('rsp_')) {
            const depto = data.replace('rsp_', '');
            await redis.set(`estado:${chatId}`, `respondiendo:${depto}`, { ex: 120 });
            await enviarMensaje(BOT_TOKEN, chatId, `✍️ Escribí tu respuesta para el visitante:`);
        }

        if (data.startsWith('borrar_')) {
            const depto = data.replace('borrar_', '');
            if (isAdmin) {
                await redis.del(`owners:${depto}`, `pass:${depto}`, `respuesta:${depto}`);
                let lista = await redis.get('lista_deptos') || [];
                await redis.set('lista_deptos', lista.filter(i => i !== depto));
            } else {
                let ows = await redis.get(`owners:${depto}`) || [];
                const nuevosOwners = ows.filter(id => id !== chatId);
                if (nuevosOwners.length === 0) {
                    // Si no queda nadie, borramos el depto de la web
                    await redis.del(`pass:${depto}`, `owners:${depto}`);
                    let lista = await redis.get('lista_deptos') || [];
                    await redis.set('lista_deptos', lista.filter(i => i !== depto));
                } else {
                    await redis.set(`owners:${depto}`, nuevosOwners);
                }
            }
            await enviarMensaje(BOT_TOKEN, chatId, `🗑️ Registro eliminado.`);
        }
        return res.status(200).send('ok');
    }

    // --- 3. LÓGICA WEB ---
    const { depto, msg, check } = req.query;
    if (!depto) return res.status(200).json(await redis.get('lista_deptos') || []);

    if (check) {
        const r = await redis.get(`respuesta:${depto}`);
        if (r) await redis.del(`respuesta:${depto}`); // Borramos para que no se repita
        return res.status(200).json({ msj: r });
    }

    // Registrar Log
    const fecha = new Date().toLocaleString("es-AR", { timeZone: "America/Argentina/Buenos_Aires" });
    await redis.lpush('timbre_logs', `🕒 [${fecha.split(' ')[1]}] - Int. ${depto}`);
    await redis.ltrim('timbre_logs', 0, 30);

    const owners = await redis.get(`owners:${depto}`) || [];
    for (const id of owners) {
        await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                chat_id: id, 
                text: msg ? `💬 **Mensaje de visita en Int. ${depto}:**\n_"${msg}"_` : `🔔 **¡Tocaron timbre en el Int. ${depto}!**`,
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
