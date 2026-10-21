import type { VercelRequest, VercelResponse } from '@vercel/node';
import axios from 'axios';
import { HttpsProxyAgent } from 'https-proxy-agent';

// --- Configuración de fuentes y estado global ---
const PROXY_SOURCES = [
  'https://raw.githubusercontent.com/themiralay/Proxy-List-World/master/data.txt',
  'https://vakhov.github.io/fresh-proxy-list/http.txt',
  'https://raw.githubusercontent.com/TheSpeedX/PROXY-List/master/http.txt',
  'https://api.proxyscrape.com/v4/free-proxy-list/get?request=display_proxies&protocol=http&proxy_format=ipport&format=text'
];

let eliteQueue: string[] = [];        // Cola de proxies ya validados y listos
let isFillingQueue = false;           // Flag para evitar validaciones concurrentes
let lastFetchTime = 0;
const QUEUE_MAX_SIZE = 12;            // Tamaño máximo de la cola
const QUEUE_MIN_THRESHOLD = 3;        // Si baja de este número, repoblar en background
const VALIDATION_TIMEOUT_MS = 3500;   // Timeout para probar un proxy con DeepL
const TRANSLATION_TIMEOUT_MS = 12000; // Timeout para la traducción real (más holgado)

// --- Función de traducción usando el endpoint "oneshot" (permisivo) ---
async function fetchDeepL(text: string, targetLang: string, proxyUrl: string) {
  const agent = new HttpsProxyAgent(proxyUrl);
  const payload = {
    text: [text],
    target_lang: targetLang.toUpperCase(),
    source_lang: 'auto'
  };

  const response = await axios.post('https://oneshot-free.www.deepl.com/v1/translate', payload, {
    httpsAgent: agent,
    headers: {
      'Content-Type': 'application/json',
      'Authorization': 'None',
      'User-Agent': 'DeepL/1.0 (iPhone; iOS 17.0; Scale/3.00)'
    },
    timeout: TRANSLATION_TIMEOUT_MS
  });

  return response.data.translations[0].text;
}

// --- Valida un proxy haciendo una micro-traducción ("hello") ---
async function testProxyWithDeepL(proxyUrl: string): Promise<boolean> {
  try {
    await fetchDeepL('hello', 'ES', proxyUrl);
    return true;
  } catch (e) {
    return false;
  }
}

// --- Rellena la cola de élite validando un lote de proxies en paralelo ---
async function fillEliteQueue() {
  if (isFillingQueue) return;
  isFillingQueue = true;

  try {
    // 1. Descargar listas si ha pasado más de 10 minutos o si es la primera vez
    let rawProxies: string[] = [];
    if (Date.now() - lastFetchTime > 10 * 60 * 1000 || eliteQueue.length === 0) {
      for (const url of PROXY_SOURCES) {
        try {
          const res = await axios.get(url, { timeout: 5000 });
          const list = res.data.split('\n').map((p: string) => p.trim()).filter((p: string) => p.length > 0);
          rawProxies = [...rawProxies, ...list];
        } catch (e) {
          // Ignorar fuentes que fallen
        }
      }
      lastFetchTime = Date.now();
    }

    // 2. Mezclar y tomar un lote de candidatos (ej. 30) para validar
    const shuffled = rawProxies.sort(() => 0.5 - Math.random()).slice(0, 30);
    const validProxies: string[] = [];

    // 3. Validar en paralelo (Promise.allSettled)
    await Promise.allSettled(
      shuffled.map(async (p) => {
        const proxyUrl = `http://${p}`;
        const isAlive = await testProxyWithDeepL(proxyUrl);
        if (isAlive) {
          validProxies.push(proxyUrl);
        }
      })
    );

    // 4. Añadir a la cola solo si no hemos alcanzado el máximo
    for (const p of validProxies) {
      if (eliteQueue.length >= QUEUE_MAX_SIZE) break;
      if (!eliteQueue.includes(p)) {
        eliteQueue.push(p);
      }
    }

    console.log(`[Queue] Repoblada. Tamaño actual: ${eliteQueue.length}`);
  } finally {
    isFillingQueue = false;
  }
}

// --- Obtiene un proxy de la cola. Si está vacía, espera a llenarla. ---
async function getEliteProxy(): Promise<string | null> {
  if (eliteQueue.length === 0) {
    await fillEliteQueue();
    if (eliteQueue.length === 0) {
      return null; // No se pudo validar ninguno
    }
  }
  return eliteQueue.shift() || null;
}

// --- Handler principal ---
export default async function handler(req: VercelRequest, res: VercelResponse) {
  // CORS
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS,PATCH,DELETE,POST,PUT');
  res.setHeader('Access-Control-Allow-Headers', 'X-CSRF-Token, X-Requested-With, Accept, Accept-Version, Content-Length, Content-MD5, Content-Type, Date, X-Api-Version');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Usa POST' });

  const { text, target_lang } = req.body;
  if (!text) return res.status(400).json({ error: 'Falta el texto a traducir' });

  try {
    let lastError: any = null;

    // Intentar hasta 3 veces con proxies de la cola (rotación rápida)
    for (let attempt = 0; attempt < 3; attempt++) {
      const proxy = await getEliteProxy();
      if (!proxy) {
        throw new Error('No hay proxies válidos disponibles en este momento. Intenta de nuevo.');
      }

      try {
        const translation = await fetchDeepL(text, target_lang || 'ES', proxy);
        // Éxito: reponer la cola si es necesario (sin await)
        if (eliteQueue.length < QUEUE_MIN_THRESHOLD) {
          fillEliteQueue().catch(console.error);
        }
        return res.status(200).json({ code: 200, data: translation });
      } catch (error: any) {
        lastError = error;
        console.warn(`[Intento ${attempt + 1}] Falló con proxy ${proxy}: ${error.message}`);
        // Si falla, simplemente continuamos al siguiente intento (tomará otro proxy de la cola)
        // Disparar reposición en background si la cola se está vaciando
        if (eliteQueue.length < QUEUE_MIN_THRESHOLD) {
          fillEliteQueue().catch(console.error);
        }
      }
    }

    // Si llegamos aquí, los 3 intentos fallaron
    throw new Error(`Agotados los reintentos. Último error: ${lastError?.message}`);
  } catch (error: any) {
    return res.status(500).json({ code: 500, message: error.message, data: null });
  }
}
