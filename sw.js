/* sw.js — Service Worker da PWA de coleta OD RBS.
 * Estratégia travada na §7.2:
 *   - shell + Leaflet + GeoJSON pesado ....... CACHE-FIRST
 *   - pontos.json / schema.json / alias.json .. NETWORK-FIRST com fallback ao cache
 *     (é por isso que dá para trocar a meta de um ponto na segunda 18h
 *      e os aparelhos verem na terça SEM reinstalar — §7.7)
 *   - POST para a API ........................ nunca passa pelo cache
 */
/* BUILD — TEM de mudar a cada release e bater com APP_VERSION do config.js.
 * É a mudança DESTE ARQUIVO que faz o navegador instalar um Service Worker novo: ele
 * compara o sw.js byte a byte. Subir só o APP_VERSION não atualiza nada — index.html,
 * app.js e config.js são cache-first, então o aparelho continuaria rodando o código
 * velho enquanto o schema.json (network-first) já teria mudado. Foi exatamente o que
 * aconteceu no 0.9.2 → 1.0: "app 0.9.2 · schema 1.0", e o V03 velho bloqueava todo
 * salvamento pedindo um campo `motivo` que o questionário novo não tem mais.
 * O test/fila_test.mjs falha se este número divergir do config.js. */
const BUILD = '0.9.20';
/* Só vire `true` numa release que QUEBRA contrato shell×dado (schema incompatível):
 * restaura o reload forçado no activate. Fora isso, NUNCA — ver incidente D3 abaixo. */
const BREAKING = false;
const CACHE = `od-rbs-v${BUILD}`;

const SHELL = [
  './', './index.html', './app.js', './queue.js', './config.js', './style.css',
  './manifest.webmanifest',
  './vendor/leaflet.js', './vendor/leaflet.css',
  './data/localidades.json', './data/pois.json', './data/ruas_rbs.geojson',
  './icons/icon-192.png', './icons/icon-512.png',
];

/* estes NUNCA são servidos do cache antes de tentar a rede */
const FRESCOS = ['/data/pontos.json', '/data/schema.json', '/data/alias.json'];
const ehFresco = (url) => FRESCOS.some((f) => url.pathname.endsWith(f));
/* Dashboards (mapa3d/central/painel) também são network-first (25/08): são telas de quem
 * está ONLINE olhando o agora — cache-first prendia o diretor numa versão velha até o
 * próximo bump de BUILD (E143). O cache continua sendo gravado: vale como fallback offline. */
const ehPainel = (url) => /\/(mapa3d|central|painel)(\/|$)/.test(url.pathname);

self.addEventListener('install', (e) => {
  e.waitUntil((async () => {
    const c = await caches.open(CACHE);
    /* cache:'reload' fura o cache HTTP do navegador (o Pages serve com max-age): sem isto
       o SW novo poderia re-gravar o app.js VELHO e a atualização não valeria de nada */
    const doZero = (u) => new Request(u, { cache: 'reload' });
    // addAll é tudo-ou-nada; aqui um 404 isolado não pode derrubar a instalação
    await Promise.all(SHELL.map((u) => c.add(doZero(u)).catch((err) => console.warn('[sw] falhou', u, err))));
    // pré-aquece os frescos, mas sem depender deles
    await Promise.all(FRESCOS.map((u) => c.add(doZero('.' + u)).catch(() => {})));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    const nomes = await caches.keys();
    const antigos = nomes.filter((n) => n.startsWith('od-rbs-v') && n !== CACHE);
    await Promise.all(antigos.map((n) => caches.delete(n)));
    await self.clients.claim();
    /* INCIDENTE D3 (26/08 08h37, relato do Luiz): o reload forçado que vivia aqui
       ("recarrega toda aba na ativação") disparava exatamente quando o 4G voltava do
       vazio — que é quando o SW novo chega — e APAGAVA a entrevista EM ANDAMENTO, que
       até 0.9.19 vivia só na RAM. "Quando salva ele tenta atualizar aí que perde."
       Agora: AVISA o app e deixa ELE escolher a hora segura (entre entrevistas). O
       app 0.9.20+ tem rascunho persistente e recarrega sozinho no próximo momento
       ocioso; shells antigas ignoram a mensagem e pegam o código novo na próxima
       abertura natural — sem schema quebrando, conviver uma tarde com shell velha é
       barato; perder 10 min de entrevista não é. `BREAKING=true` restaura o reload
       forçado para a única situação que o justifica. */
    if (antigos.length) {
      const cls = await self.clients.matchAll({ type: 'window' });
      for (const c of cls) {
        if (BREAKING) { try { await c.navigate(c.url); } catch (e) {} }
        else { try { c.postMessage({ tipo: 'sw_atualizado', build: BUILD }); } catch (e) {} }
      }
    }
  })());
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;                       // POST da API passa direto
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;        // nada de terceiros (sem tiles externas)

  if (ehFresco(url) || ehPainel(url)) {
    /* NETWORK-FIRST */
    e.respondWith((async () => {
      try {
        const r = await fetch(req, { cache: 'no-store' });
        if (r && r.ok) (await caches.open(CACHE)).put(req, r.clone());
        return r;
      } catch {
        const c = await caches.match(req, { ignoreSearch: true });
        if (c) return c;
        return new Response(JSON.stringify({ erro: 'offline e sem cache' }),
          { status: 503, headers: { 'Content-Type': 'application/json' } });
      }
    })());
    return;
  }

  /* CACHE-FIRST */
  e.respondWith((async () => {
    const c = await caches.match(req, { ignoreSearch: true });
    if (c) return c;
    try {
      const r = await fetch(req);
      if (r && r.ok && r.type === 'basic') (await caches.open(CACHE)).put(req, r.clone());
      return r;
    } catch {
      if (req.mode === 'navigate') {
        const shell = await caches.match('./index.html');
        if (shell) return shell;
      }
      return new Response('offline', { status: 503 });
    }
  })());
});

/* Background Sync — existe no Chrome/Android, NÃO existe no iOS.
   No iPhone valem o evento `online`, o timer de 30 s e o botão manual (§7.3). */
self.addEventListener('sync', (e) => {
  if (e.tag !== 'od-sync') return;
  e.waitUntil((async () => {
    const cls = await self.clients.matchAll({ includeUncontrolled: true, type: 'window' });
    cls.forEach((c) => c.postMessage({ tipo: 'sincronize' }));
  })());
});

self.addEventListener('message', (e) => {
  if (e.data === 'skipWaiting') self.skipWaiting();
});
