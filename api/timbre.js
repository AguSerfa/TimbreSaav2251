import { kv } from '@vercel/kv';

export default async function handler(req, res) {
    const BOT_TOKEN = process.env.BOT_TOKEN;

    // --- 1. REGISTRO DE VECINOS (Vía Telegram Webhook) ---
    // Esto se activa cuando un vecino le escribe al Bot: /alta 4
    if (req.body && req.body.message) {
        const msg = req.body.message.text;
        const chatId = req.body.message.chat.id;

        if (msg && msg.startsWith('/alta')) {
            const depto = msg.split(' ')[1]; // Extrae el número/letra después de /alta
            
            if (!depto) {
                await enviarTelegram(chatId, "⚠️ Por favor, indicá el interno. Ejemplo: /alta 4", BOT_TOKEN);
                return res.status(200).send('ok');
            }

            // Guardamos quién es el dueño del depto (ID de Telegram)
            await kv.set(`owner:${depto}`, chatId); 
            
            // Agregamos el depto a la lista global de botones
            let lista = await kv.get('lista_deptos') || [];
            if (!lista.includes(depto)) {
                lista.push(depto);
                await kv.set('lista_deptos', lista.sort());
            }

            await enviarTelegram(chatId, `✅ ¡Listo! Ahora recibirás los avisos del Interno ${depto} aquí.`, BOT_TOKEN);
            return res.status(200).send('ok');
        }
        return res.status(200).send('ok');
    }

    // --- 2. LISTADO DE BOTONES (Para la Web) ---
    // Si la web entra sin avisar un depto, le mandamos la lista de botones activos
    const { depto } = req.query;
    if (!depto) {
        const botones = await kv.get('lista_deptos') || [];
        return res.status(200).json(botones);
    }

    // --- 3. TOCAR EL TIMBRE (Desde la Web) ---
    // Buscamos quién está registrado para ese depto
    const destinoId = await kv.get(`owner:${depto}`);

    if (destinoId) {
        await enviarTelegram(destinoId, `🔔 ¡ATENCIÓN! Alguien está tocando el timbre en el Interno ${depto}.`, BOT_TOKEN);
        return res.status(200).send("Enviado al vecino");
    } else {
        // Si nadie está registrado, te llega a vos (opcional)
        const ADMIN_ID = process.env.CHAT_ID;
        await enviarTelegram(ADMIN_ID, `🔔 Timbre en Interno ${depto} (Nadie registrado aún).`, BOT_TOKEN);
        return res.status(200).send("Enviado al administrador");
    }
}

// Función auxiliar para no repetir código de envío
async function enviarTelegram(chatId, mensaje, token) {
    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId, text: mensaje })
    });
}
