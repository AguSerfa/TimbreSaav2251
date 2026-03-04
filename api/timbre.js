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

        if (!msg) return res.status(200).send('ok');

        // --- 1. ALTA ---
        if (msg.startsWith('/alta')) {
            const depto = msg.split(' ')[1];
            if (!depto) return res.status(200).send('ok');

            await redis.set(`owner:${depto}`, chatId);
            let lista = await redis.get('lista_deptos') || [];
            if (!lista.includes(depto)) {
                lista.push(depto);
                await redis.set('lista_deptos', lista.sort());
            }

            await enviarMensaje(BOT_TOKEN, chatId, `✅ Interno ${depto} registrado.`);
            return res.status(200).send('ok');
        }

        // --- 2. LISTADO PARA BAJA (Botones) ---
        if (msg === '/baja') {
            const lista = await redis.get('lista_deptos') || [];
            if (lista.length === 0) {
                await enviarMensaje(BOT_TOKEN, chatId, "No hay internos para borrar.");
                return res.status(200).send('ok');
            }

            const botones = lista.map(d => ([{ text: `Borrar ${d}`, callback_data: `borrar_${d}` }]));
            
            await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    chat_id: chatId,
                    text: "Seleccioná qué interno querés dar de baja:",
                    reply_markup: { inline_keyboard: botones }
                })
            });
            return res.status(200).send('ok');
        }
    }

    // --- 3. ACCIÓN DE BORRAR (Callback de los botones) ---
    if (req.body && req.body.callback_query) {
        const data = req.body.callback_query.data;
        const chatId = req.body.callback_query.message.chat.id;
        const msgId = req.body.callback_query.message.message_id;

        if (data.startsWith('borrar_')) {
            const depto = data.replace('borrar_', '');
            
            await redis.del(`owner:${depto}`);
            let lista = await redis.get('lista_deptos') || [];
            lista = lista.filter(item => item !== depto);
            await redis.set('lista_deptos', lista);

            await enviarMensaje(BOT_TOKEN, chatId, `🗑️ Interno ${depto} eliminado.`);
            
            // Borra el mensaje de los botones para que no quede ahí
            await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/deleteMessage`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ chat_id: chatId, message_id: msgId })
            });
        }
        return res.status(200).send('ok');
    }

    // --- 4. WEB (TIMBRE) ---
    const { depto } = req.query;
    if (!depto) {
        const botones = await redis.get('lista_deptos') || [];
        return res.status(200).json(botones);
    }

    const destinoId = await redis.get(`owner:${depto}`) || ADMIN_ID;
    await enviarMensaje(BOT_TOKEN, destinoId, `🔔 Timbre en Interno ${depto}`);
    return res.status(200).send("ok");
}

async function enviarMensaje(token, chat, texto) {
    return fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: chat, text: texto })
    });
}
