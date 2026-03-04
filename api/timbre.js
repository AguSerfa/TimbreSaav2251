import { Redis } from '@upstash/redis';

export default async function handler(req, res) {
    const BOT_TOKEN = process.env.TELEGRAM_TOKEN;
    const ADMIN_ID = process.env.TELEGRAM_CHAT_ID;

    // Conexión automática usando las variables que se crearon recién
    const redis = new Redis({
        url: process.env.KV_REST_API_URL || process.env.REDIS_URL,
        token: process.env.KV_REST_API_TOKEN || process.env.REDIS_REST_API_TOKEN,
    });

    // 1. LÓGICA DE REGISTRO (Telegram)
    if (req.body && req.body.message) {
        const msg = req.body.message.text;
        const chatId = req.body.message.chat.id;

        if (msg && msg.startsWith('/alta')) {
            const depto = msg.split(' ')[1];
            if (!depto) return res.status(200).send('ok');

            await redis.set(`owner:${depto}`, chatId);
            let lista = await redis.get('lista_deptos') || [];
            if (!lista.includes(depto)) {
                lista.push(depto);
                await redis.set('lista_deptos', lista.sort());
            }

            await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ chat_id: chatId, text: `✅ Registrado en Interno ${depto}` })
            });
        }
        return res.status(200).send('ok');
    }

    // 2. LÓGICA DE LA WEB (Botones y Timbre)
    const { depto } = req.query;
    if (!depto) {
        const botones = await redis.get('lista_deptos') || [];
        return res.status(200).json(botones);
    }

    const destinoId = await redis.get(`owner:${depto}`) || ADMIN_ID;
    await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: destinoId, text: `🔔 Timbre en Interno ${depto}` })
    });

    return res.status(200).send("ok");
}
