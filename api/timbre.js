import { Redis } from '@upstash/redis';

export default async function handler(req, res) {
    const BOT_TOKEN = process.env.TELEGRAM_TOKEN;
    const ADMIN_ID = process.env.TELEGRAM_CHAT_ID;

    const redis = new Redis({
        url: process.env.KV_REST_API_URL || process.env.REDIS_URL,
        token: process.env.KV_REST_API_TOKEN || process.env.REDIS_REST_API_TOKEN,
    });

    // --- 1. MENSAJES DE TELEGRAM (COMANDOS Y RESPUESTAS) ---
    if (req.body && req.body.message) {
        const msg = req.body.message.text;
        const chatId = req.body.message.chat.id;
        if (!msg) return res.status(200).send('ok');

        const estado = await redis.get(`estado:${chatId}`);

        // CASO: El vecino está respondiendo al timbre (Intercomunicador)
        if (estado && estado.startsWith('respondiendo:')) {
            const depto = estado.split(':')[1];
            // Guardamos la respuesta en Redis por 2 minutos para que la web la lea
            await redis.set(`respuesta:${depto}`, msg, { ex: 120 });
            await redis.del(`estado:${chatId}`);
            await enviarMensaje(BOT_TOKEN, chatId, `✅ Enviaste al timbre: "${msg}"`);
            return res.status(200).send('ok');
        }

        // CASO: El vecino está enviando la contraseña del /alta
        if (estado && estado.startsWith('esperando_pass:')) {
            const depto = estado.split(':')[1];
            const passwordIngresada = msg.trim();
            const passGuardada = await redis.get(`pass:${depto}`);

            if (passGuardada && passGuardada !== passwordIngresada) {
                await enviarMensaje(BOT_TOKEN, chatId, "🚫 Contraseña incorrecta. Reintentá.");
                await redis.del(`estado:${chatId}`);
                return res.status(200).send('ok');
            }

            if (!passGuardada) await redis.set(`pass:${depto}`, passwordIngresada);

            let owners = await redis.get(`owners:${depto}`) || [];
            if (!owners.includes(chatId)) {
                owners.push(chatId);
                await redis.set(`owners:${depto}`, owners);
            }

            let lista = await redis.get('lista_deptos') || [];
            if (!lista.includes(depto)) {
                lista.push(depto.toUpperCase());
                await redis.set('lista_deptos', lista.sort());
            }

            await redis.del(`estado:${chatId}`);
            await enviarMensaje(BOT_TOKEN, chatId, `✅ Registrado en **${depto}**.`);
            return res.status(200).send('ok');
        }

        // COMANDO /LISTA (SOLO ADMIN)
        if (msg === '/lista' && String(chatId) === String(ADMIN_ID)) {
            const lista = await redis.get('lista_deptos') || [];
            if (lista.length === 0) return enviarMensaje(BOT_TOKEN, chatId, "No hay nadie registrado.");
            
            let texto = "📋 **Lista de Internos:**\n\n";
            for (const d of lista) {
                const pass = await redis.get(`pass:${d}`);
                const ows = await redis.get(`owners:${d}`) || [];
                texto += `🏠 **${d}**\n🔑 Clave: \`${pass}\`\n👥 Personas: ${ows.length}\n\n`;
            }
            await enviarMensaje(BOT_TOKEN, chatId, texto);
            return res.status(200).send('ok');
        }

        // COMANDO /ALTA
        if (msg.startsWith('/alta')) {
            const depto = msg.split(' ')[1]?.toUpperCase();
            if (!depto) return enviarMensaje(BOT_TOKEN, chatId, "Usá: `/alta [depto]`");
            
            await redis.set(`estado:${chatId}`, `esperando_pass:${depto}`, { ex: 300 });
            const existe = await redis.get(`pass:${depto}`);
            await enviarMensaje(BOT_TOKEN, chatId, existe ? `🔐 Clave para **${depto}**:` : `🆕 Inventá clave para **${depto}**:`);
            return res.status(200).send('ok');
        }

        // COMANDO /BAJA
        if (msg === '/baja') {
            const lista = await redis.get('lista_deptos') || [];
            let botones = [];
            if (String(chatId) === String(ADMIN_ID)) {
                for (const d of lista) botones.push([{ text: `Borrar ${d}`, callback_data: `borrar_${d}` }]);
            } else {
                for (const d of lista) {
                    const ows = await redis.get(`owners:${d}`) || [];
                    if (ows.includes(chatId)) botones.push([{ text: `Salir de ${d}`, callback_data: `borrar_${d}` }]);
                }
            }
            if (botones.length === 0) return enviarMensaje(BOT_TOKEN, chatId, "Nada que borrar.");
            await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ chat_id: chatId, text: "Seleccioná:", reply_markup: { inline_keyboard: botones }})
            });
            return res.status(200).send('ok');
        }
    }

    // --- 2. CALLBACKS (BOTONES DE TELEGRAM) ---
    if (req.body && req.body.callback_query) {
        const data = req.body.callback_query.data;
        const chatId = req.body.callback_query.message.chat.id;

        // BOTÓN RESPONDER AL TIMBRE
        if (data.startsWith('rsp_')) {
            const depto = data.replace('rsp_', '');
            await redis.set(`estado:${chatId}`, `respondiendo:${depto}`, { ex: 120 });
            await enviarMensaje(BOT_TOKEN, chatId, `✍️ Escribí tu respuesta para el Interno ${depto}:`);
        }

        // BOTÓN BORRAR
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

    // --- 3. LÓGICA WEB (NOTIFICAR Y CONSULTAR RESPUESTAS) ---
    const { depto, msg, check } = req.query;

    if (!depto) {
        const botones = await redis.get('lista_deptos') || [];
        return res.status(200).json(botones);
    }

    // Si la web pregunta si hay respuesta del vecino
    if (check) {
        const respuesta = await redis.get(`respuesta:${depto}`);
        return res.status(200).json({ msj: respuesta || null });
    }

    // Si alguien toca el timbre
    const owners = await redis.get(`owners:${depto}`) || [];
    const textoAlerta = msg ? `🔔 **¡TIMBRE EN ${depto}!**\n📝 _"${msg}"_` : `🔔 **¡TIMBRE EN ${depto}!**`;

    for (const ownerId of owners) {
        await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                chat_id: ownerId,
                text: textoAlerta,
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
