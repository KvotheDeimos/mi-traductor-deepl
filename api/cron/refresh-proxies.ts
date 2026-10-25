import type { VercelRequest, VercelResponse } from '@vercel/node';
import axios from 'axios';
import { HttpsProxyAgent } from 'https-proxy-agent';

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://wvznuhohgqruoclffghr.supabase.co';
const SUPABASE_KEY = process.env.SUPABASE_KEY || 'sb_publishable_jteTR9TTo0xWMZK1gwddLQ_YME5EQ8D';
const DEEPL_ENDPOINT = 'https://www2.deepl.com/jsonrpc?client=chrome-extension,1.28.0';

// Formato y firma JSON-RPC requerida por DeepL para no devolver 429/error de sintaxis
function formatDeepLPayload(text: string, targetLang: string) {
  const ts = Date.now();
  const id = (Math.floor(Math.random() * 99999) + 100000) * 1000;
  const payload = {
    jsonrpc: '2.0',
    method: 'LMT_handle_jobs',
    params: {
      jobs: [{ kind: 'default', sentences: [{ text, id: 1, prefix: '' }], raw_en_context_before: [], raw_en_context_after: [] }],
      lang: { target_lang: targetLang },
      priority: 1,
      commonJobParams: { mode: 'translate', textType: 'plaintext' },
      timestamp: ts,
    },
    id,
  };
  let jsonBody = JSON.stringify(payload);
  if ((id + 5) % 29 === 0 || (id + 3) % 13 === 0) {
    jsonBody = jsonBody.replace('"method":', '"method" : ');
  } else {
    jsonBody = jsonBody.replace('"method":', '"method": ');
  }
  return jsonBody;
}

async function testProxyWithDeepL(proxyUrl: string, timeoutMs = 3500): Promise<{ ok: boolean; latency: number }> {
  const t0 = Date.now();
  try {
    const agent = new HttpsProxyAgent(proxyUrl, { timeout: timeoutMs });
    const body = formatDeepLPayload('hello', 'ES');
    const res = await axios.post(DEEPL_ENDPOINT, body, {
      httpsAgent: agent,
      proxy: false, // Requerido para evitar conflictos de túnel en Axios
      timeout: timeoutMs,
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      },
    });

    if (res.status === 429) {
      return { ok: true, latency: Date.now() - t0 };
    }
    const trans = res.data?.result?.translations?.[0]?.beams?.[0]?.sentences?.[0]?.text;
    const ok = typeof trans === 'string' && trans.trim().length > 0;
    return { ok, latency: Date.now() - t0 };
  } catch {
    return { ok: false, latency: 9999 };
  }
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  try {
    // 1. Descarga lista fresca de proxies HTTP
    const sourceRes = await axios.get(
      'https://api.proxyscrape.com/v2/?request=displayproxies&protocol=http&timeout=3000&country=all&ssl=all&anonymity=all',
      { timeout: 4000 }
    ).catch(() => ({ data: '' }));

    const rawLines = typeof sourceRes.data === 'string' ? sourceRes.data.split('\n') : [];
    const candidates = rawLines
      .map((l: string) => l.trim())
      .filter((l: string) => l.includes(':') && !l.startsWith('#'))
      .sort(() => 0.5 - Math.random())
      .slice(0, 20);

    // 2. Probar los 20 proxies EN PARALELO (se completa en ~3.5s)
    const testResults = await Promise.allSettled(
      candidates.map(async (ipPort: string) => {
        const proxyUrl = `http://${ipPort}`;
        const check = await testProxyWithDeepL(proxyUrl, 3500);
        return { proxyUrl, ...check };
      })
    );

    const validProxies: { url: string; latency_ms: number; status: string; last_verified: string }[] = [];
    for (const r of testResults) {
      if (r.status === 'fulfilled' && r.value.ok) {
        validProxies.push({
          url: r.value.proxyUrl,
          latency_ms: r.value.latency,
          status: 'healthy',
          last_verified: new Date().toISOString(),
        });
      }
    }

    // 3. Guardar en Supabase usando REST nativo (cero dependencias externas)
    let savedCount = 0;
    if (validProxies.length > 0) {
      const sbRes = await fetch(`${SUPABASE_URL}/rest/v1/deepl_proxies`, {
        method: 'POST',
        headers: {
          apikey: SUPABASE_KEY,
          Authorization: `Bearer ${SUPABASE_KEY}`,
          'Content-Type': 'application/json',
          Prefer: 'resolution=merge-duplicates,return=representation',
        },
        body: JSON.stringify(validProxies),
      });

      if (sbRes.ok) {
        const savedData = await sbRes.json();
        savedCount = Array.isArray(savedData) ? savedData.length : validProxies.length;
      }
    }

    return res.status(200).json({
      status: 'success',
      proxies_probados: candidates.length,
      proxies_guardados: savedCount,
      proxies: validProxies.map((p) => p.url),
    });
  } catch (err: any) {
    return res.status(500).json({ status: 'error', message: err.message });
  }
}
