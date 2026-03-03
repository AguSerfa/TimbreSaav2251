export default async function handler(req, res) {
  // Estos secretos los cargaremos en Vercel después para que nadie los vea
  const token = process.env.TELEGRAM_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  
  const { depto } = req.query;
  const mensaje = `🔔 ¡Agustín! Alguien tocó el timbre del: ${depto || 'Alguien'}`;

  const url = `https://api.telegram.org/bot${token}/sendMessage?chat_id=${chatId}&text=${encodeURIComponent(mensaje)}`;

  try {
    await fetch(url);
    // Agregamos permisos para que tu web pueda hablar con este archivo
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.status(200).send("Enviado");
  } catch (error) {
    res.status(500).send("Error");
  }
}
