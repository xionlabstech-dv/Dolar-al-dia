// Worker de tasas — Xion Labs
// Fuente única para BCV (dólar y euro) + USDT P2P, con caché en KV.
// Cualquier producto de Xion Labs puede llamar a GET /api/tasas sin autenticación.

const CACHE_KEY = 'rates:latest';

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };
}

function json(payload, status = 200) {
  return new Response(JSON.stringify(payload, null, 2), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'public, max-age=300',
      ...corsHeaders(),
    },
  });
}

async function fetchWithTimeout(url, options = {}, ms = 8000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    const res = await fetch(url, { ...options, signal: controller.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status} en ${url}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

// --- BCV (vía dolarapi.com, mismo endpoint que ya usa Calculadora de Tasa) ---
async function fetchBCV() {
  const [usdResult, eurResult] = await Promise.allSettled([
    fetchWithTimeout('https://ve.dolarapi.com/v1/dolares/oficial'),
    fetchWithTimeout('https://ve.dolarapi.com/v1/euros/oficial'),
  ]);

  if (usdResult.status !== 'fulfilled') {
    throw new Error('No se pudo obtener el dolar BCV');
  }

  const usd = usdResult.value;
  const eur = eurResult.status === 'fulfilled' ? eurResult.value : null;

  return {
    usd: usd.promedio,
    eur: eur ? eur.promedio : null,
    fecha: usd.fechaActualizacion,
    fuente: usd.fuente || 'BCV',
  };
}

// --- USDT P2P (Binance) ---
// OJO: este endpoint no es oficial ni está documentado por Binance, se arma a partir
// de lo que se observa en el tráfico de la app/web de P2P. Puede cambiar de forma
// o bloquear IPs de datacenter (como las de Cloudflare Workers) sin aviso.
// Si en producción empieza a fallar seguido, la salida es cambiar esta función
// por un agregador público (cotizave.com, pydolarve.org) sin tocar el resto del Worker.
async function fetchBinanceAds(tradeType) {
  const data = await fetchWithTimeout(
    'https://p2p.binance.com/bapi/c2c/v2/friendly/c2c/adv/search',
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        'Referer': 'https://p2p.binance.com/en/trade/all-payments/USDT?fiat=VES',
        'Origin': 'https://p2p.binance.com',
        'clienttype': 'web',
      },
      body: JSON.stringify({
        page: 1,
        rows: 10,
        payTypes: [],
        asset: 'USDT',
        tradeType,
        fiat: 'VES',
        publisherType: null,
        merchantCheck: false,
      }),
    },
    8000
  );

  const ads = (data.data || [])
    .map((item) => Number(item.adv.price))
    .filter((price) => Number.isFinite(price));

  if (!ads.length) throw new Error(`Sin anuncios de USDT/VES (${tradeType})`);

  const top = ads.slice(0, 5);
  const avg = top.reduce((sum, p) => sum + p, 0) / top.length;
  return Math.round(avg * 100) / 100;
}

async function fetchBinanceP2P() {
  const [compra, venta] = await Promise.all([
    fetchBinanceAds('BUY'),
    fetchBinanceAds('SELL'),
  ]);
  return {
    compra,
    venta,
    promedio: Math.round(((compra + venta) / 2) * 100) / 100,
    fuente: 'Binance P2P (no oficial)',
  };
}

// --- Caché ---
async function getCached(env) {
  const raw = await env.RATES_KV.get(CACHE_KEY);
  return raw ? JSON.parse(raw) : null;
}

async function refreshRates(env) {
  const [bcvResult, usdtResult] = await Promise.allSettled([
    fetchBCV(),
    fetchBinanceP2P(),
  ]);

  const previous = await getCached(env);

  const bcv = bcvResult.status === 'fulfilled' ? bcvResult.value : previous?.bcv ?? null;
  const usdt = usdtResult.status === 'fulfilled' ? usdtResult.value : previous?.usdt ?? null;

  const payload = {
    bcv,
    usdt,
    meta: {
      updated_at: new Date().toISOString(),
      bcv_ok: bcvResult.status === 'fulfilled',
      usdt_ok: usdtResult.status === 'fulfilled',
      bcv_error: bcvResult.status === 'rejected' ? String(bcvResult.reason) : null,
      usdt_error: usdtResult.status === 'rejected' ? String(usdtResult.reason) : null,
    },
  };

  await env.RATES_KV.put(CACHE_KEY, JSON.stringify(payload));
  return payload;
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders() });
    }

    if (url.pathname === '/api/tasas' || url.pathname === '/') {
      let cached = await getCached(env);

      if (!cached) {
        // Primera vez que corre el Worker, todavía no hay nada en KV.
        cached = await refreshRates(env);
      }

      return json(cached);
    }

    if (url.pathname === '/api/tasas/refresh') {
      // Endpoint manual para forzar un refresco (útil para probar en desarrollo).
      const fresh = await refreshRates(env);
      return json(fresh);
    }

    return json({ error: 'Ruta no encontrada' }, 404);
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(refreshRates(env));
  },
};
