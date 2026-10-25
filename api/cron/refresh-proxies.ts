import type { VercelRequest, VercelResponse } from '@vercel/node';
import axios from 'axios';
import { HttpsProxyAgent } from 'https-proxy-agent';

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://wvznuhohgqruoclffghr.supabase.co';
const SUPABASE_KEY = process.env.SUPABASE_KEY || 'sb_publishable_jteTR9TTo0xWMZK1gwddLQ_YME5EQ8D';
const CRON_SECRET = process.env.CRON_SECRET;

const PROXY_SOURCES = [
  'https://api.proxyscrape.com/v4/free-proxy-list/get?request=display_proxies&protocol=http&proxy_format=ipport&format=json',
  'https://raw.githubusercontent.com/TheSpeedX/PROXY-List/master/http.txt',
  'https://raw.githubusercontent.com/vakhov/fresh-proxy-list/master/http.txt'
];

const DEEPL_TEST_ENDPOINT = 'https://www2.deepl.com/jsonrpc?client=chrome-extension,1.28.0';

function parseProxyList(data: any): { ip: string; port: number }[] {
  const results: { ip: string; port: number }[] = [];
  if (typeof data === 'string') {
    for (const line of data.split('\n')) {
      const [host, portStr] = line.trim().split(':');
      const port = parseInt(portStr, 10);
      if (host && !isNaN(port) && port > 0) results.push({ ip: host, port });
    }
  } else if (Array.isArray(data)) {
    for (const item of data) {
      if (item.ip && item.port) results.push({ ip: item.ip, port: Number(item.port) });
    }
  } else if (data?.data && Array.isArray(data.data)) {
    for (const item of data.data) {
      if (item.ip && item.port) results.push({ ip: item.ip, port: Number(item.port) });
    }
  }
  return results;
}

async function testProxy(proxyUrl: string): Promise<{ ok: boolean; latency: number }> {
  const t0 = Date.now();
  try {
    const agent = new HttpsProxyAgent(proxyUrl, { rejectUnauthorized: false, timeout: 3000 });
    const payload = {
      jsonrpc: '2.0',
      method: 'LMT_handle_jobs',
      params: {
        jobs: [{ kind: 'default', sentences: [{ text: 'hello', id: 1, prefix: '' }], raw_en_context_before: [], raw_en_context_after: [] }],
        lang: { target_lang: 'ES', source_lang_user_selected: 'auto' },
        timestamp: Date.now()
      },
      id: Math.floor(Math.random() * 100000) + 100000
    };
    const res = await axios.post(DEEPL_TEST_ENDPOINT, payload, {
      httpsAgent: agent,
      headers: { 'Content-Type': 'application/json', 'User-Agent': 'Mozilla/5.0' },
      timeout: 3000
    });
    const hasTranslation = res.data?.result?.translations?.[0]?.beams?.[0]?.sentences?.[0]?.text !== undefined;
    return { ok: hasTranslation, latency: Date.now() - t0 };
  } catch {
    return { ok: false, latency: 9999 };
  }
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  // Validación opcional de seguridad
  if (CRON_SECRET) {
    const auth = req.headers.authorization;
    if (auth !== `Bearer ${CRON_SECRET}`) {
      return res.status(401).json({ error: 'No autorizado' });
    }
  }

  try {
    // 1. Descargar listas
    const results = await Promise.allSettled(PROXY_SOURCES.map(url => axios.get(url, { timeout: 3500 })));
    let candidates: { ip: string; port: number }[] = [];
    for (const r of results) {
      if (r.status === 'fulfilled') candidates.push(...parseProxyList(r.value.data));
    }

    // 2. Tomar 35 candidatos aleatorios
    const unique = Array.from(new Map(candidates.map(p => [`${p.ip}:${p.port}`, p])).values());
    const sample = unique.sort(() => 0.5 - Math.random()).slice(0, 35);

    // 3. Validar en lotes de 10
    const verified: { url: string; latency_ms: number; last_verified: string; status: string }[] = [];
    const BATCH_SIZE = 10;

    for (let i = 0; i < sample.length; i += BATCH_SIZE) {
      const batch = sample.slice(i, i + BATCH_SIZE);
      await Promise.allSettled(
        batch.map(async (p) => {
          const proxyUrl = `http://${p.ip}:${p.port}`;
          const { ok, latency } = await testProxy(proxyUrl);
          if (ok) {
            verified.push({
              url: proxyUrl,
              latency_ms: latency,
              last_verified: new Date().toISOString(),
              status: 'active'
            });
          }
        })
      );
      if (verified.length >= 15) break;
    }

    // 4. Guardar en Supabase (UPSERT)
    if (verified.length > 0) {
      await axios.post(`${SUPABASE_URL}/rest/v1/deepl_proxies`, verified, {
        headers: {
          apikey: SUPABASE_KEY,
          Authorization: `Bearer ${SUPABASE_KEY}`,
          'Content-Type': 'application/json',
          Prefer: 'resolution=merge-duplicates'
        },
        timeout: 4000
      });
    }

    return res.status(200).json({
      status: 'success',
      proxies_validados_y_guardados: verified.length,
      proxies: verified.map(p => p.url)
    });
  } catch (error: any) {
    return res.status(500).json({ status: 'error', message: error.message });
  }
}
