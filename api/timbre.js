import { Redis } from '@upstash/redis';

export default async function handler(req, res) {
    const BOT_TOKEN = process.env.TELEGRAM_TOKEN;
    const ADMIN_ID = process.env.TELEGRAM_CHAT_ID;

    const redis = new Redis({
        url: process.env.KV_REST_API_URL || process.env.REDIS_URL,
        token: process.env.KV_REST_API_TOKEN || process.env.REDIS_REST_API_TOKEN,
    });

    // --- 1. LÓGICA DE MENSAJES DE TELEGRAM ---
    if (req.body && req.body.message) {
        const msg = req.body.message.text;
        const chatId = req.body.message.chat.id;
        const isAdmin = String(chatId) === String(ADMIN_ID);

        if (!msg) return res.status(200).send('ok');

        const estado = await redis.get(`estado:${chatId}`);

        // CASO: Respondiendo al timbre (Intercomunicador)
        if (estado && estado.startsWith('respondiendo:')) {
            const depto = estado.split(':')[1];
            // Guardamos el mensaje y el nombre del depto
            await redis.set(`respuesta:${depto}`, msg, { ex: 120 });
            await redis.del(`estado:${chatId}`);
            await enviarMensaje(BOT_TOKEN, chatId, `✅ Enviado a la calle: "${msg}"`);
            return res.status(200).send('ok');
        }

        // CASO: Enviando clave de alta
        if (estado && estado.startsWith('esperando_pass:')) {
            const depto = estado.split(':')[1];
            const passGuardada = await redis.get(`pass:${depto}`);
            if (passGuardada && passGuardada !== msg.trim()) {
                await enviarMensaje(BOT_TOKEN, chatId, "🚫 Clave incorrecta. El alta se canceló.");
                await redis.del(`estado:${chatId}`);
                return res.status(200).send('ok');
            }
            if (!passGuardada) await redis.set(`pass:${depto}`, msg.trim());
            let owners = await redis.get(`owners:${depto}`) || [];
            if (!owners.includes(chatId)) {
                owners.push(chatId);
                await redis.set(`owners:${depto}`, owners);
            }
            let lista = await redis.get('lista_deptos') || [];
            if (!lista.includes(depto)) {
                lista.push(depto);
                await redis.set('lista_deptos', lista.sort());
            }
            await redis.del(`estado:${chatId}`);
            await enviarMensaje(BOT_TOKEN, chatId, `✅ ¡Listo! Ya sos parte del Interno ${depto}.`);
            return res.status(200).send('ok');
        }

        // --- MENÚ PRINCIPAL CON BOTONES ---
        if (msg === '/start' || msg === 'Hola' || msg === 'Menu') {
            const teclado = [
                [{ text: "🏠 Registrarme" }, { text: "🗑️ Darme de Baja" }]
            ];
            if (isAdmin) {
                teclado.push([{ text: "📋 Ver Lista (Claves)" }, { text: "🚨 Borrar Cualquier Interno" }]);
            }

            await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    chat_id: chatId,
                    text: isAdmin ? "👑 **Panel de Administrador**\nHola Agustín, ¿qué necesitás hacer?" : "👋 **Timbre Saavedra 2251**\nBienvenido, elegí una opción:",
                    reply_markup: { keyboard: teclado, resize_keyboard: true }
                })
            });
            return res.status(200).send('ok');
        }

        // ACCIÓN: REGISTRARME
        if (msg === "🏠 Registrarme") {
            await enviarMensaje(BOT_TOKEN, chatId, "Escribí el nombre del interno (Ejemplo: `1A`):");
            await redis.set(`estado:${chatId}`, "esperando_depto", { ex: 60 });
            return res.status(200).send('ok');
        }

        // ACCIÓN: INTERNO ENVIADO TRAS CLIC EN REGISTRARME
        if (estado === "esperando_depto") {
            const depto = msg.toUpperCase().trim();
            await redis.set(`estado:${chatId}`, `esperando_pass:${depto}`, { ex: 300 });
            const existe = await redis.get(`pass:${depto}`);
            await enviarMensaje(BOT_TOKEN, chatId, existe ? `🔐 El interno ${depto} ya existe. Escribí la clave:` : `🆕 El interno ${depto} es nuevo. Inventá una clave:`);
            return res.status(200).send('ok');
        }

        // ACCIÓN: LISTA (ADMIN)
        if (msg === "📋 Ver Lista (Claves)" && isAdmin) {
            const lista = await redis.get('lista_deptos') || [];
            if (lista.length === 0) return enviarMensaje(BOT_TOKEN, chatId, "No hay nadie registrado.");
            let txt = "📋 **Internos Registrados:**\n\n";
            for (const d of lista) {
                const p = await redis.get(`pass:${d}`);
                const ow = await redis.get(`owners:${d}`) || [];
                txt += `🏠 **Interno ${d}**\n🔑 Clave: \`${p}\`\n👥 Personas: ${ow.length}\n\n`;
            }
            await enviarMensaje(BOT_TOKEN, chatId, txt);
            return res.status(200).send('ok');
        }

        // ACCIÓN: BORRAR (VECINO O ADMIN)
        if (msg === "🗑️ Darme de Baja" || (msg === "🚨 Borrar Cualquier Interno" && isAdmin)) {
            const lista = await redis.get('lista_deptos') || [];
            let btns = [];
            for (const d of lista) {
                const ows = await redis.get(`owners:${d}`) || [];
                if (isAdmin || ows.includes(chatId)) {
                    btns.push([{ text: isAdmin ? `🚨 ELIMINAR ${d}` : `Salir de ${d}`, callback_data: `borrar_${d}` }]);
                }
            }
            if (btns.length === 0) return enviarMensaje(BOT_TOKEN, chatId, "No tenés internos asociados.");
            await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ chat_id: chatId, text: "Seleccioná cuál borrar:", reply_markup: { inline_keyboard: btns }})
            });
            return res.status(200).send('ok');
        }
    }

    // --- 2. CALLBACKS (BOTONES INLINE) ---
    if (req.body && req.body.callback_query) {
        const data = req.body.callback_query.data;
        const chatId = req.body.callback_query.message.chat.id;
        const isAdmin = String(chatId) === String(ADMIN_ID);

        if (data.startsWith('rsp_')) {
            const depto = data.replace('rsp_', '');
            await redis.set(`estado:${chatId}`, `respondiendo:${depto}`, { ex: 120 });
            await enviarMensaje(BOT_TOKEN, chatId, `✍️ Escribí tu respuesta para el Interno ${depto}:`);
        }

        if (data.startsWith('borrar_')) {
            const depto = data.replace('borrar_', '');
            if (isAdmin) {
                await redis.del(`owners:${depto}`, `pass:${depto}`, `respuesta:${depto}`);
                let lista = await redis.get('lista_deptos') || [];
                await redis.set('lista_deptos', lista.filter(i => i !== depto));
                await enviarMensaje(BOT_TOKEN, chatId, `🗑️ Interno ${depto} borrado del sistema.`);
            } else {
                let ows = await redis.get(`owners:${depto}`) || [];
                await redis.set(`owners:${depto}`, ows.filter(id => id !== chatId));
                await enviarMensaje(BOT_TOKEN, chatId, `🗑️ Saliste del interno ${depto}.`);
            }
            await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/deleteMessage`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ chat_id: chatId, message_id: req.body.callback_query.message.message_id })
            });
        }
        return res.status(200).send('ok');
    }

    // --- 3. LÓGICA WEB ---
    const { depto, msg, check } = req.query;
    if (!depto) return res.status(200).json(await redis.get('lista_deptos') || []);

    if (check) {
        const r = await redis.get(`respuesta:${depto}`);
        return res.status(200).json({ msj: r });
    }

    const owners = await redis.get(`owners:${depto}`) || [];
    const t = msg ? `🔔 **¡TIMBRE EN EL INTERNO ${depto}!**\n📝 _"${msg}"_` : `🔔 **¡TIMBRE EN EL INTERNO ${depto}!**`;

    for (const id of owners) {
        await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                chat_id: id, text: t, parse_mode: 'Markdown',
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
