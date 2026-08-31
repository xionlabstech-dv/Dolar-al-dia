# dolar-al-dia-api

Worker central de tasas para los productos de Xion Labs. Trae dólar y euro BCV,
más USDT P2P (Binance), los cachea en KV, y los sirve en un solo endpoint JSON
sin autenticación y con CORS abierto — para que Dólar al Día, Calculadora de
Tasa, Caja, Zlip y Skuela puedan llamarlo directo desde el navegador.

**Importante:** esto es un Cloudflare Worker, no un proyecto de Cloudflare
Pages. Es un producto distinto en el dashboard de Cloudflare, aunque puede
vivir en la misma cuenta y hasta en el mismo repo de GitHub que el frontend
estático — simplemente se despliega con `wrangler`, no con la integración
automática de Pages.

## Despliegue

```bash
cd dolar-al-dia-worker
npm install

# Inicia sesión en tu cuenta de Cloudflare (una sola vez)
npx wrangler login

# Crea el namespace de KV donde se guarda la caché
npx wrangler kv namespace create RATES_KV
```

Ese último comando imprime un `id`. Pégalo en `wrangler.toml`, en el campo
`id` bajo `[[kv_namespaces]]`.

```bash
npx wrangler deploy
```

Al terminar te da una URL tipo `https://dolar-al-dia-api.<tu-subdominio>.workers.dev`.
Pruébala:

```bash
curl https://dolar-al-dia-api.<tu-subdominio>.workers.dev/api/tasas
```

La primera llamada puede tardar un par de segundos porque el Worker todavía
no tiene nada en caché y hace el fetch en vivo. Después de eso, el cron
(cada 15 minutos) mantiene la caché fresca y las respuestas son instantáneas.

## Contrato de la API

`GET /api/tasas`

```json
{
  "bcv": {
    "usd": 794.9917,
    "eur": 922.69,
    "fecha": "2026-08-31T00:00:00.000Z",
    "fuente": "BCV"
  },
  "usdt": {
    "compra": 861.02,
    "venta": 869.75,
    "promedio": 865.38,
    "fuente": "Binance P2P (no oficial)"
  },
  "meta": {
    "updated_at": "2026-08-31T14:32:07.512Z",
    "bcv_ok": true,
    "usdt_ok": true,
    "bcv_error": null,
    "usdt_error": null
  }
}
```

Si una fuente falla, el Worker no rompe la respuesta entera: devuelve el
último valor bueno que tenga en caché para esa fuente, y lo marca con
`bcv_ok: false` o `usdt_ok: false` más el mensaje en `*_error`. Así el cliente
puede decidir si avisa al usuario que el dato está desactualizado.

`GET /api/tasas/refresh` — fuerza un refresco inmediato (ignora el cron).
Útil para probar en desarrollo; no lo expongas como botón público porque
cada llamada le pega directo a BCV y Binance.

## Fuente de USDT: Cotizave

El Worker ya no le pega directo a `p2p.binance.com` para el USDT: ese
endpoint no es oficial, no tiene documentación de Binance, y Binance bloquea
las IPs de datacenter (las de Cloudflare Workers entran en esa categoría)
con HTTP 403 — agregar headers de navegador no lo resolvió.

En su lugar, `fetchUSDT()` llama a [Cotizave](https://cotizave.com), un
agregador con API documentada que ya resuelve ese bloqueo y expone el precio
de Binance P2P (`market: "binance_p2p"`) sin que el Worker tenga que hablar
con Binance directamente.

Esto requiere un secret `COTIZAVE_API_KEY` configurado en el Worker
(`npx wrangler secret put COTIZAVE_API_KEY`), fuera del código y de este
repo. Sin ese secret, `fetchUSDT()` falla y el Worker cae al último valor
bueno en caché, igual que con cualquier otra falla de fuente (`usdt_ok:
false` + `usdt_error`). El resto del sistema (caché, CORS, fallback,
contrato de la API) queda igual.

## Cron

`wrangler.toml` tiene `crons = ["*/15 * * * *"]` — corre cada 15 minutos,
24/7. El BCV solo cambia una vez al día hábil (~4:30pm hora Caracas), así
que estás refrescando ese dato más seguido de lo necesario, pero el costo es
básicamente cero en el plan gratis de Workers y así el USDT (que sí se mueve
más) se mantiene razonablemente fresco.
