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
        try {
            const logs = await redis.lrange('timbre_logs', 0, 30);
            return res.status(200).json(logs || []);
        } catch (e) {
            return res.status(500).json({ error: "Error al leer logs" });
        }
    }

    // --- 2. MENSAJES DE TEXTO (Webhook de Telegram) ---
    if (req.body && req.body.message) {
        const msgTxt = req.body.message.text;
        const chatId = req.body.message.chat.id;
        const isAdmin = String(chatId) === String(ADMIN_ID);
        if (!msgTxt) return res.status(200).send('ok');

        const estado = await redis.get(`estado:${chatId}`);

        // Respuesta a la visita
        if (estado && estado.startsWith('respondiendo:')) {
            const d = estado.split(':')[1];
            await redis.set(`respuesta:${d}`, msgTxt, { ex: 90 });
            await redis.del(`estado:${chatId}`);
            await enviarMensaje(BOT_TOKEN, chatId, `✅ Enviado al interno ${d}: "${msgTxt}"`);
            return res.status(200).send('ok');
        }

        // Proceso de Registro (Ingreso de Clave)
        if (estado && estado.startsWith('esperando_pass:')) {
            const d = estado.split(':')[1];
            const passGuardada = await redis.get(`pass:${d}`);
            
            if (passGuardada && passGuardada !== msgTxt.trim()) {
                await enviarMensaje(BOT_TOKEN, chatId, "🚫 **Clave incorrecta.** El registro fue cancelado por seguridad.");
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
            await enviarMensaje(BOT_TOKEN, chatId, `✅ **¡Registro Exitoso!**\n\nYa estás vinculado al **Interno ${d}**. A partir de ahora, recibirás los avisos de este timbre directamente en este chat.`);
            return res.status(200).send('ok');
        }

        // Menú Principal
        const botones = [
            [{ text: "🏠 Registrarme", callback_data: "m_reg" }, { text: "🗑️ Darme de Baja", callback_data: "m_baja" }],
            [{ text: "🎵 Sonido de Timbre", callback_data: "m_audio" }]
        ];
        if (isAdmin) {
            botones.push([{ text: "📋 Ver Lista", callback_data: "m_lista" }, { text: "📜 Ver Logs", callback_data: "m_logs" }]);
        }

        await enviarMensaje(BOT_TOKEN, chatId, isAdmin ? "👑 **Panel de Administrador**" : "👋 **Timbre Digital - Saavedra 2251**\nSeleccioná una opción:", { inline_keyboard: botones });
        return res.status(200).send('ok');
    }

    // --- 3. CALLBACKS (Botones del Bot) ---
    if (req.body && req.body.callback_query) {
        const data = req.body.callback_query.data;
        const chatId = req.body.callback_query.message.chat.id;
        const isAdmin = String(chatId) === String(ADMIN_ID);

        // Elegir interno para registro
        if (data === "m_reg") {
            const filas = [];
            for (let i = 1; i <= 15; i += 3) {
                filas.push([
                    { text: `Int. ${i}`, callback_data: `reg_${i}` },
                    { text: `Int. ${i+1}`, callback_data: `reg_${i+1}` },
                    { text: `Int. ${i+2}`, callback_data: `reg_${i+2}` }
                ]);
            }
            await enviarMensaje(BOT_TOKEN, chatId, "🏠 **¿En qué número de interno vivís?**", { inline_keyboard: filas });
        } 
        
        else if (data.startsWith('reg_')) {
            const d = data.replace('reg_', '');
            await redis.set(`estado:${chatId}`, `esperando_pass:${d}`, { ex: 300 });
            const existe = await redis.get(`pass:${d}`);
            
            if (existe) {
                await enviarMensaje(BOT_TOKEN, chatId, `🔐 **El interno ${d} ya tiene dueño.**\n\nPara sumarte a este interno, por favor escribí la clave de acceso de la vivienda:`);
            } else {
                await enviarMensaje(BOT_TOKEN, chatId, `🆕 **Vas a dar de alta el interno ${d}.**\n\nPor favor, inventá una clave de seguridad (letras o números) para que otros miembros de tu casa puedan sumarse después:`);
            }
        }

        else if (data === "m_audio") {
            await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendAudio`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ 
                    chat_id: chatId, 
                    audio: AUDIO_ID, 
                    caption: "🔔 Este es el sonido que escucharás cuando alguien toque el timbre en la web." 
                })
            });
        }

        else if (data === "m_lista" && isAdmin) {
            const lista = await redis.get('lista_deptos') || [];
            if (lista.length === 0) return enviarMensaje(BOT_TOKEN, chatId, "No hay internos registrados.");

            let txt = "📋 **REPORTE DE INTERNOS:**\n\n";
            for (const d of lista) {
                const p = await redis.get(`pass:${d}`);
                const ows = await redis.get(`owners:${d}`) || [];
                txt += `🏠 **Interno ${d}**\n   🔑 Clave: \`${p}\` \n   👥 Miembros: ${ows.length}\n   🆔 IDs: \`${ows.join(', ')}\`\n\n`;
            }
            await enviarMensaje(BOT_TOKEN, chatId, txt);
        }

        else if (data === "m_logs" && isAdmin) {
            const logs = await redis.lrange('timbre_logs', 0, 15);
            const txt = logs.length ? "📜 **Últimos movimientos:**\n" + logs.join('\n') : "No hay actividad reciente.";
            await enviarMensaje(BOT_TOKEN, chatId, txt);
        }

       else if (data.startsWith('borrar_')) {
    const d = data.replace('borrar_', '');
    
    // 1. Traemos la lista de dueños. Si no existe, usamos un array vacío.
    let ows = await redis.get(`owners:${d}`) || [];
    
    // 2. Identificamos al creador (el primero de la lista).
    const creatorId = ows.length > 0 ? String(ows[0]) : null;
    const currentChatId = String(chatId);

    // 3. CASO 1: Es el ADMIN global o es el CREADOR del interno
    if (isAdmin || currentChatId === creatorId) {
        // Borrado TOTAL de la base de datos para este interno
        await redis.del(`owners:${d}`);
        await redis.del(`pass:${d}`);
        await redis.del(`respuesta:${d}`);
        
        // Lo sacamos de la lista global de la web
        let lista = await redis.get('lista_deptos') || [];
        const nuevaLista = lista.filter(i => String(i) !== String(d));
        await redis.set('lista_deptos', nuevaLista);

        await enviarMensaje(BOT_TOKEN, chatId, `🗑️ **Interno ${d} eliminado.**\nEl botón ya no aparecerá en la web y todos los usuarios fueron desvinculados.`);
    } 
    
    // 4. CASO 2: Es un invitado (Miembro)
    else if (ows.includes(chatId)) {
        // Solo se borra a sí mismo de la lista de notificaciones
        const nuevosOwners = ows.filter(id => String(id) !== currentChatId);
        await redis.set(`owners:${d}`, nuevosOwners);

        await enviarMensaje(BOT_TOKEN, chatId, `👋 **Te has desvinculado del Interno ${d}.**\nYa no recibirás avisos, pero el timbre sigue activo para el resto de los residentes.`);
    } 
    
    // 5. CASO 3: Por las dudas (si el interno ya no existe o ya no estaba ahí)
    else {
        await enviarMensaje(BOT_TOKEN, chatId, `⚠️ No tenés permisos para borrar el Interno ${d} o ya no figurás en la lista.`);
    }
}

        else if (data.startsWith('borrar_')) {
            const d = data.replace('borrar_', '');
            // Si es admin borra todo, si es vecino solo se sale él
            if (isAdmin) {
                await redis.del(`owners:${d}`, `pass:${d}`, `respuesta:${d}`);
                let lista = await redis.get('lista_deptos') || [];
                await redis.set('lista_deptos', lista.filter(i => i !== d));
            } else {
                let ows = await redis.get(`owners:${d}`) || [];
                const nuevos = ows.filter(id => String(id) !== String(chatId));
                if (nuevos.length === 0) {
                    await redis.del(`owners:${d}`, `pass:${d}`);
                    let lista = await redis.get('lista_deptos') || [];
                    await redis.set('lista_deptos', lista.filter(i => i !== d));
                } else {
                    await redis.set(`owners:${d}`, nuevos);
                }
            }
            await enviarMensaje(BOT_TOKEN, chatId, `🗑️ Se ha procesado la baja del interno ${d}.`);
        }

        if (data.startsWith('rsp_')) {
            const d = data.replace('rsp_', '');
            await redis.set(`estado:${chatId}`, `respondiendo:${d}`, { ex: 120 });
            await enviarMensaje(BOT_TOKEN, chatId, `✍️ Escribí a continuación el mensaje que querés que vea la visita en la pantalla:`);
        }

        return res.status(200).send('ok');
    }

    // --- 4. LÓGICA WEB (Peticiones desde el navegador) ---
    if (!depto) {
        const lista = await redis.get('lista_deptos') || [];
        return res.status(200).json(lista);
    }

    if (check) {
        const r = await redis.get(`respuesta:${depto}`);
        if (r) await redis.del(`respuesta:${depto}`);
        return res.status(200).json({ msj: r });
    }

    // REGISTRO DE LOG Y ENVÍO DE ALERTA
    const fecha = new Date().toLocaleString("es-AR", { timeZone: "America/Argentina/Buenos_Aires" });
    const hora = fecha.split(' ')[1] || fecha;
    await redis.lpush('timbre_logs', `🕒 [${hora}] - Llamada al Int. ${depto}`);
    await redis.ltrim('timbre_logs', 0, 30);

    const owners = await redis.get(`owners:${depto}`) || [];
    for (const id of owners) {
        await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                chat_id: id, 
                text: msg ? `💬 **Mensaje en Int. ${depto}:**\n_"${msg}"_` : `🔔 **¡Están tocando timbre en el Int. ${depto}!**`,
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
