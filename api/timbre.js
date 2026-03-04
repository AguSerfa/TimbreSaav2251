import { Redis } from '@upstash/redis';

export default async function handler(req, res) {
    const BOT_TOKEN = process.env.TELEGRAM_TOKEN;
    const ADMIN_ID = process.env.TELEGRAM_CHAT_ID;

    const redis = new Redis({
        url: process.env.KV_REST_API_URL || process.env.REDIS_URL,
        token: process.env.KV_REST_API_TOKEN || process.env.REDIS_REST_API_TOKEN,
    });

    // --- 1. MENSAJES DE TELEGRAM ---
    if (req.body && req.body.message) {
        const msg = req.body.message.text;
        const chatId = req.body.message.chat.id;
        if (!msg) return res.status(200).send('ok');

        // Chequeamos si el usuario estaba en medio de un proceso (Estado)
        const estado = await redis.get(`estado:${chatId}`);

        // CASO A: El usuario está enviando la contraseña después de un /alta
        if (estado && estado.startsWith('esperando_pass:')) {
            const depto = estado.split(':')[1];
            const passwordIngresada = msg.trim();
            const passGuardada = await redis.get(`pass:${depto}`);

            if (passGuardada && passGuardada !== passwordIngresada) {
                await enviarMensaje(BOT_TOKEN, chatId, "🚫 **Contraseña incorrecta**. Pedile la clave a los que ya viven ahí o reintentá.");
                await redis.del(`estado:${chatId}`);
                return res.status(200).send('ok');
            }

            // Si es nuevo depto, guardamos la pass
            if (!passGuardada) {
                await redis.set(`pass:${depto}`, passwordIngresada);
            }

            // Agregamos al usuario a la lista de ese depto
            let owners = await redis.get(`owners:${depto}`) || [];
            if (!owners.includes(chatId)) {
                owners.push(chatId);
                await redis.set(`owners:${depto}`, owners);
            }

            // Agregamos a la lista global de la web
            let lista = await redis.get('lista_deptos') || [];
            if (!lista.includes(depto)) {
                lista.push(depto);
                await redis.set('lista_deptos', lista.sort());
            }

            await redis.del(`estado:${chatId}`);
            await enviarMensaje(BOT_TOKEN, chatId, `✅ **¡Perfecto!** Ya sos parte del Interno **${depto}**. Recibirás los avisos junto a tus compañeros.`);
            return res.status(200).send('ok');
        }

        // COMANDO ALTA: /alta 1A
        if (msg.startsWith('/alta')) {
            const depto = msg.split(' ')[1];
            if (!depto) {
                await enviarMensaje(BOT_TOKEN, chatId, "❌ Error. Usá: `/alta [depto]` (Ej: `/alta 1A`).");
                return res.status(200).send('ok');
            }

            const existe = await redis.get(`pass:${depto}`);
            await redis.set(`estado:${chatId}`, `esperando_pass:${depto}`, { ex: 300 }); // Expira en 5 min

            if (existe) {
                await enviarMensaje(BOT_TOKEN, chatId, `🔐 El Interno **${depto}** ya existe. Escribí la **contraseña** para sumarte:`);
            } else {
                await enviarMensaje(BOT_TOKEN, chatId, `🆕 El Interno **${depto}** es nuevo. Inventá una **contraseña** para este depto:`);
            }
            return res.status(200).send('ok');
        }

        // COMANDO BAJA (Con visualización de claves para el Admin)
        if (msg === '/baja') {
            const lista = await redis.get('lista_deptos') || [];
            let botones = [];

            if (String(chatId) === String(ADMIN_ID)) {
                // MODO ADMIN: Ve todos y sus claves
                for (const d of lista) {
                    const clave = await redis.get(`pass:${d}`);
                    botones.push([{ text: `Borrar ${d} (🔑: ${clave})`, callback_data: `borrar_${d}` }]);
                }
                await enviarMensaje(BOT_TOKEN, chatId, "👑 **Modo Admin**: Aquí tenés todos los deptos y sus claves.");
            } else {
                // MODO VECINO: Solo ve los suyos
                for (const d of lista) {
                    const owners = await redis.get(`owners:${d}`) || [];
                    if (owners.includes(chatId)) {
                        botones.push([{ text: `Borrarme de ${d}`, callback_data: `borrar_${d}` }]);
                    }
                }
            }

            if (botones.length === 0) {
                await enviarMensaje(BOT_TOKEN, chatId, "No tenés internos registrados.");
                return res.status(200).send('ok');
            }

            await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    chat_id: chatId,
                    text: "Seleccioná el interno que querés eliminar:",
                    reply_markup: { inline_keyboard: botones }
                })
            });
            return res.status(200).send('ok');
        }

        // AYUDA
        await enviarMensaje(BOT_TOKEN, chatId, "👋 **Timbre Digital**\n\n🔹 `/alta [depto]` - Para registrarte.\n🔹 `/baja` - Para salir.");
        return res.status(200).send('ok');
    }

    // --- 2. CALLBACKS (BOTONES) ---
    if (req.body && req.body.callback_query) {
        const data = req.body.callback_query.data;
        const chatId = req.body.callback_query.message.chat.id;
        const msgId = req.body.callback_query.message.message_id;

        if (data.startsWith('borrar_')) {
            const depto = data.replace('borrar_', '');
            
            // Si es Admin, borra todo el depto. Si no, solo se borra él.
            if (String(chatId) === String(ADMIN_ID)) {
                await redis.del(`owners:${depto}`);
                await redis.del(`pass:${depto}`);
                let lista = await redis.get('lista_deptos') || [];
                lista = lista.filter(item => item !== depto);
                await redis.set('lista_deptos', lista);
                await enviarMensaje(BOT_TOKEN, chatId, `🗑️ Interno ${depto} eliminado por completo.`);
            } else {
                let owners = await redis.get(`owners:${depto}`) || [];
                owners = owners.filter(id => id !== chatId);
                await redis.set(`owners:${depto}`, owners);
                await enviarMensaje(BOT_TOKEN, chatId, `🗑️ Ya no recibirás avisos del ${depto}.`);
            }

            await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/deleteMessage`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ chat_id: chatId, message_id: msgId })
            });
        }
        return res.status(200).send('ok');
    }

    // --- 3. LÓGICA WEB (NOTIFICACIÓN MULTI-USUARIO) ---
    const { depto, msg } = req.query;
    if (!depto) {
        const botones = await redis.get('lista_deptos') || [];
        return res.status(200).json(botones);
    }

    const owners = await redis.get(`owners:${depto}`) || [];
    const textoAlerta = msg 
        ? `🔔 **¡TIMBRE EN ${depto}!**\n📝 **Mensaje:** _"${msg}"_`
        : `🔔 **¡TIMBRE!** Alguien toca en el **Interno ${depto}**.`;

    // Le mandamos a TODOS los que vivan ahí
    for (const ownerId of owners) {
        await enviarMensaje(BOT_TOKEN, ownerId, textoAlerta);
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
