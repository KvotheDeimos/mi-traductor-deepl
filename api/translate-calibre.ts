import type { VercelRequest, VercelResponse } from '@vercel/node';
import axios from 'axios';
import { HttpsProxyAgent } from 'https-proxy-agent';

// 🔥 LISTA DE ENDPOINTS DE DEEPL (Rotación para evitar bloqueos)
const DEEPL_ENDPOINTS = [
  'https://www2.deepl.com/jsonrpc?client=chrome-extension,1.28.0', // Chrome (El más estable)
  'https://www2.deepl.com/jsonrpc?client=edge-extension,1.3.0',    // Edge
  'https://www2.deepl.com/jsonrpc?client=firefox-extension,1.2.0', // Firefox
  'https://www2.deepl.com/jsonrpc?method=LMT_handle_jobs',         // Web Desktop
  'https://www2.deepl.com/jsonrpc',                               // Web Base
  'https://oneshot-free.www.deepl.com/v1/translate'               // Endpoint móvil (Fallback)
];

const PROXY_SOURCES = [
  'https://raw.githubusercontent.com/themiralay/Proxy-List-World/master/data.txt',
  'https://raw.githubusercontent.com/vakhov/fresh-proxy-list/master/http.txt',
  'https://raw.githubusercontent.com/TheSpeedX/PROXY-List/master/http.txt'
];

let pool: string[] = [];
let lastFetchTime = 0;

function normalizeLang(lang: string): string {
  if (!lang) return 'ES';
  const l = lang.trim().toUpperCase();
  if (l === 'SPANISH' || l === 'ES') return 'ES';
  if (l === 'ENGLISH' || l === 'EN') return 'EN';
  return l;
}

// 🔥 Función que intenta traducir con un proxy y un endpoint específico
async function fetchDeepL(text: string, targetLang: string, proxyUrl: string, endpoint: string) {
  const agent = new HttpsProxyAgent(proxyUrl, { rejectUnauthorized: false });
  const finalTargetLang = normalizeLang(targetLang);

  // Si el endpoint es el de "oneshot" (móvil), usamos su formato de payload
  if (endpoint.includes('oneshot-free')) {
    const payload = { text: [text], target_lang: finalTargetLang, source_lang: 'auto' };
    const response = await axios.post(endpoint, payload, {
      httpsAgent: agent,
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'None',
        'User-Agent': 'DeepL/1.0 (iPhone; iOS 17.0; Scale/3.00)'
      },
      timeout: 3000
    });
    return response.data.translations[0].text;
  } 
  // Si es un endpoint JSON-RPC (extensiones/web), usamos su formato específico
  else {
    const payload = {
      jsonrpc: "2.0",
      method: "LMT_handle_jobs",
      params: {
        jobs: [{ kind: "default", sentences: [{ text: text, id: 1, prefix: "" }], raw_en_context_before: [], raw_en_context_after: [], preferred_num_beams: 1 }],
        lang: { target_lang: finalTargetLang, source_lang_user_selected: "auto" },
        priority: 1,
        commonJobParams: { mode: "translate", textType: "plaintext" },
        timestamp: Date.now()
      },
      id: Math.floor(Math.random() * 100000) + 100000
    };

    const response = await axios.post(endpoint, payload, {
      httpsAgent: agent,
      headers: {
        'Content-Type': 'application/json',
        'Accept': '*/*',
        'Accept-Language': 'en-US,en;q=0.9,es;q=0.8',
        'Origin': 'https://www.deepl.com',
        'Referer': 'https://www.deepl.com/translator',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
      },
      timeout: 3000
    });
    
    // Extraer el texto de la respuesta JSON-RPC
    const translations = response.data?.result?.translations;
    if (translations && translations[0]?.beams?.[0]?.sentences?.[0]?.text) {
      return translations[0].beams[0].sentences[0].text;
    }
    throw new Error('Respuesta JSON-RPC sin traducciones válidas');
  }
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  
  const { text, target, target_lang } = req.body;
  const finalTarget = target || target_lang;

  if (!text) return res.status(400).json({ error: 'Falta el texto' });

  try {
    // 1. Descargar lista de proxies si no la tenemos
    if (Date.now() - lastFetchTime > 5 * 60 * 1000 || pool.length === 0) {
      const results = await Promise.allSettled(PROXY_SOURCES.map(url => axios.get(url, { timeout: 3000 })));
      let rawProxies: string[] = [];
      for (const r of results) {
        if (r.status === 'fulfilled') {
          rawProxies = [...rawProxies, ...r.value.data.split('\n').map((p: string) => p.trim()).filter(Boolean)];
        }
      }
      pool = rawProxies.filter(p => !p.includes('socks')).sort(() => 0.5 - Math.random());
      lastFetchTime = Date.now();
    }

    // 2. Tomamos 3 proxies al azar para esta petición
    const proxiesToTry = pool.splice(0, 3);

    // 3. Intentamos con cada proxy, y para cada proxy probamos todos los endpoints
    for (const rawProxy of proxiesToTry) {
      const proxyUrl = `http://${rawProxy}`;
      
      // Mezclamos los endpoints para no usar siempre el mismo
      const shuffledEndpoints = [...DEEPL_ENDPOINTS].sort(() => 0.5 - Math.random());

      for (const endpoint of shuffledEndpoints) {
        try {
          const translation = await fetchDeepL(text, finalTarget || 'ES', proxyUrl, endpoint);
          // Si funciona, devolvemos la traducción inmediatamente
          return res.status(200).json({ code: 200, data: translation });
        } catch (e) {
          // Si falla (timeout, 429, error de formato), el bucle pasa al siguiente endpoint
        }
      }
    }

    // 4. Si todo falla, devolvemos el texto original para que Calibre no muestre error
    return res.status(200).json({ code: 200, data: text });

  } catch (error: any) {
    return res.status(200).json({ code: 200, data: text });
  }
}
