import { createClient } from '@vercel/kv';

export default async function handler(req, res) {
    // Usamos los nombres EXACTOS de tu captura image_39b095.png
    const BOT_TOKEN = process.env.TELEGRAM_TOKEN;
    const ADMIN_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

    // Configuración de la base de datos usando tus variables de Vercel
    const kv = createClient({
        url: process.env.KV_REST_API_URL || process.env.STORAGE_KV_REST_API_URL,
        token: process.env.KV_REST_API_TOKEN || process.env.STORAGE_KV_REST_API_TOKEN,
    });

    // --- 1. REGISTRO DE VECINOS ---
    if (req.body && req.body.message) {
        const msg = req.body.message.text;
        const chatId = req.body.message.chat.id;

        if (msg && msg.startsWith('/alta')) {
            const depto = msg.split(' ')[1];
            if (!depto) return res.status(200).send('ok');

            await kv.set(`owner:${depto}`, chatId);
            let lista = await kv.get('lista_deptos') || [];
            if (!lista.includes(depto)) {
                lista.push(depto);
                await kv.set('lista_deptos', lista.sort());
            }

            await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ chat_id: chatId, text: `✅ Registrado en Interno ${depto}` })
            });
            return res.status(200).send('ok');
        }
    }

    // --- 2. LISTADO Y TIMBRE ---
    const { depto } = req.query;
    if (!depto) {
        const botones = await kv.get('lista_deptos') || [];
        return res.status(200).json(botones);
    }

    const destinoId = await kv.get(`owner:${depto}`) || ADMIN_CHAT_ID;
    await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: destinoId, text: `🔔 Timbre en Interno ${depto}` })
    });
    
    return res.status(200).send("ok");
}
