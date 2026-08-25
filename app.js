/* app.js — PWA de coleta da pesquisa OD de Rio Branco do Sul.
 * Renderer SCHEMA-DRIVEN: as telas 1..9 saem de data/schema.json, não daqui.
 * Toda a lógica de fila/ACK/validação vive em queue.js (puro, testado em Node).
 */
import { APP_VERSION, API_URL, SYNC_INTERVALO_MS, LOTE_MAX, TOKEN_VALIDADE } from './config.js';
import {
  novoUuid, haversine, ordenarPontosPorDistancia, classificarAccuracy, periodoDe,
  normalizar, buscarVias, validar, ehDescarteSilencioso, montarLote, enviarLote,
  filaEsperaMin, dentroDoPoligono, foraDoMunicipio, avaliarPosicao, avaliarCota,
} from './queue.js';

/* ================================================================ IndexedDB */
const DB_NOME = 'od-rbs-db', DB_VER = 1;
let _db = null;

function abrirDb() {
  return new Promise((res, rej) => {
    const rq = indexedDB.open(DB_NOME, DB_VER);
    rq.onupgradeneeded = () => {
      const db = rq.result;
      if (!db.objectStoreNames.contains('respostas')) {
        const s = db.createObjectStore('respostas', { keyPath: 'uuid' });
        s.createIndex('status', 'status'); s.createIndex('dia', 'dia');
      }
      if (!db.objectStoreNames.contains('recusas')) {
        const s = db.createObjectStore('recusas', { keyPath: 'uuid' });
        s.createIndex('status', 'status'); s.createIndex('dia', 'dia');
      }
      if (!db.objectStoreNames.contains('meta')) db.createObjectStore('meta', { keyPath: 'k' });
    };
    rq.onsuccess = () => res(rq.result);
    rq.onerror = () => rej(rq.error);
  });
}
const db = async () => (_db ||= await abrirDb());
function tx(store, modo, fn) {
  return db().then((d) => new Promise((res, rej) => {
    const t = d.transaction(store, modo), s = t.objectStore(store);
    let out; try { out = fn(s); } catch (e) { rej(e); return; }
    t.oncomplete = () => res(out && out.result !== undefined ? out.result : out);
    t.onerror = () => rej(t.error); t.onabort = () => rej(t.error);
  }));
}
const put = (store, v) => tx(store, 'readwrite', (s) => s.put(v));
const todos = (store) => tx(store, 'readonly', (s) => s.getAll());
const metaSet = (k, v) => put('meta', { k, v });
const metaGet = async (k) => (await tx('meta', 'readonly', (s) => s.get(k)))?.v;

/* ================================================================ estado */
const S = {
  sessao: null,          // {pesquisador_id, nome, token, validade, meta_dia, device_id}
  schema: null, pontos: [], localidades: null, pois: [], vias: [], limiteRing: null, alias: {},
  ponto: null,           // ponto selecionado
  fix: null,             // {lat, lon, acc, ts, fonte}
  r: null,               // entrevista em curso
  tela: 0,               // índice da tela do schema
  vista: 'boot',
  fila: 0, contDia: 0,
  feitoPontos: null,     // {mapa:{ponto_id:n}, em:ms} — quadro do TIME, vindo do servidor
  cotaAvisada: {},       // evita repetir o toast de cota a cada fix de GPS
  enviando: false, wakeLock: null, mapa: null, marcador: null,
};
/* o quadro do time envelhece: passou disto, o cabeçalho assume que só sabe o próprio aparelho */
const FEITO_VALIDADE_MS = 2 * 60 * 60 * 1000;
/* quem enxerga a vista de gestão. O gestor TAMBÉM entrevista — isto é camada a mais, não outra. */
const GESTOR = 'G01';
/** Único juiz de "sou o gestor?" no cliente. O servidor recusa não-G01 de qualquer jeito. */
const ehGestor = () => S.sessao?.pesquisador_id === GESTOR;
const SYNC_ATENCAO_MIN = 45, SYNC_ALERTA_MIN = 120;
const el = (id) => document.getElementById(id);
const main = () => el('main');
const hoje = () => new Date().toISOString().slice(0, 10);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/* ================================================================ instalar na tela inicial
 * Feedback do Luiz (1º usuário real, 24/08): "não dá a opção de baixar, fica no Chrome".
 * O navegador só oferece a instalação num menu escondido; aqui ela vira um botão grande.
 * O evento chega ANTES do boot, por isso o listener é de módulo, não de função. */
let promptInstalar = null;
const jaInstalado = () =>
  matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;

window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();                 // sem isto o Chrome mostra a barrinha dele e some
  promptInstalar = e;
  ligarInstalar();
});
window.addEventListener('appinstalled', () => {
  promptInstalar = null;
  document.getElementById('inst-bt')?.remove();
});

const blocoInstalar = () => (jaInstalado() ? '' :
  `<button class="b-grande b-primario" id="inst-bt" style="text-align:center">📲 Instalar o aplicativo</button>`);

function ligarInstalar() {
  const b = document.getElementById('inst-bt');
  if (!b) return;
  b.onclick = async () => {
    if (promptInstalar) {
      promptInstalar.prompt();
      const r = await promptInstalar.userChoice.catch(() => null);
      if (r && r.outcome === 'accepted') { promptInstalar = null; b.remove(); }
      return;
    }
    comoInstalar();     // iPhone e afins: o evento não existe, então ensinamos o caminho
  };
}

/** Passo a passo curto, em letra grande, sem jargão. */
function comoInstalar() {
  const ios = /iphone|ipad|ipod/i.test(navigator.userAgent) ||
              (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  return modal({
    titulo: 'Deixar o app na tela inicial',
    corpo: ios
      ? `<ol class="passos">
           <li>Ache o botão <b>Compartilhar</b> <span class="ic-p">⬆️</span> (quadrado com seta pra cima).
               Não achou na barra? Toque nos <b>três pontinhos ⋯</b> no canto de baixo —
               o Compartilhar está lá dentro.</li>
           <li>Role a lista e toque em <b>Adicionar à Tela de Início</b>.</li>
           <li>Toque em <b>Adicionar</b>, no canto de cima.</li>
         </ol><p class="dica">Depois disso o ícone fica junto dos outros aplicativos — abra sempre por ele.</p>`
      : `<ol class="passos">
           <li>Toque nos <b>três pontinhos</b> <span class="ic-p">⋮</span> no canto de cima.</li>
           <li>Toque em <b>Instalar aplicativo</b> (ou <b>Adicionar à tela inicial</b>).</li>
           <li>Confirme em <b>Instalar</b>.</li>
         </ol><p class="dica">Depois disso o ícone fica junto dos outros aplicativos.</p>`,
    acoes: [{ id: 'ok', rotulo: 'Entendi', estilo: 'b-primario' }],
  });
}

/* ================================================================ UI utils */
let toastT;
function toast(msg, tipo = '') {
  const t = el('toast'); t.textContent = msg; t.className = tipo; t.hidden = false;
  clearTimeout(toastT); toastT = setTimeout(() => (t.hidden = true), tipo === 'erro' ? 5200 : 2600);
}
/* modal() — extensão RETROCOMPATÍVEL (0.9.15). Ação sem `valor` nem `trava` se comporta
 * exatamente como antes: resolve com o id, string pura. Os campos novos servem ao modal
 * com input de texto:
 *   ac.trava()  -> true segura o modal aberto (ex.: campo vazio)
 *   ac.valor()  -> lido do DOM ANTES de fechar; a ação resolve com {id, valor}
 *   aoAbrir()   -> roda com o modal já visível (focar o input)                        */
function modal({ titulo, corpo, acoes, aoAbrir }) {
  return new Promise((res) => {
    el('modal-t').textContent = titulo;
    el('modal-c').innerHTML = corpo || '';
    const a = el('modal-a'); a.innerHTML = '';
    acoes.forEach((ac) => {
      const b = document.createElement('button');
      b.textContent = ac.rotulo; b.className = ac.estilo || 'b-fantasma';
      b.onclick = () => {
        if (ac.trava && ac.trava()) return;               // fica aberto de propósito
        const v = ac.valor ? ac.valor() : undefined;      // ler antes de fechar
        el('modal').hidden = true;
        res(ac.valor ? { id: ac.id, valor: v } : ac.id);
      };
      a.appendChild(b);
    });
    el('modal').hidden = false;
    if (aoAbrir) aoAbrir();
  });
}

/* ================================================================ GPS (§7.3) */
let _pinturaGps = 0;
function iniciarGps() {
  if (!navigator.geolocation) { S.fix = null; S.gpsErro = 2; return; }
  navigator.geolocation.watchPosition(
    (p) => {
      S.gpsErro = 0;
      S.fix = {
        lat: p.coords.latitude, lon: p.coords.longitude,
        acc: p.coords.accuracy, ts: new Date(p.timestamp).toISOString(),
        fonte: p.coords.accuracy <= 100 ? 'gps' : 'rede',
      };
      /* O GPS pulsa ~1×/s e cada pintura relê as DUAS stores do IndexedDB — era isso
       * que deixava o app "lento e travando" em Android (Luiz, 24/08 21h35). Nada no
       * cabeçalho muda por causa do fix; 10 s de folga aqui não mudam nada visível.
       * Ações reais (salvar, sync, trocar ponto, login) pintam direto, sem espera. */
      if (Date.now() - _pinturaGps > 10000) pintarCabecalho();
    },
    (err) => { S.gpsErro = err && err.code || 2; /* mantém o último fix; nunca zera o que já foi bom */ },
    { enableHighAccuracy: true, maximumAge: 15000, timeout: 60000 }
  );
}
const fixVelho = () => !S.fix || (Date.now() - new Date(S.fix.ts).getTime()) / 1000 > 120;

/* GPS é GATE DURO da operação (decisão do dono, 24/08 19h40): sem fix fresco a
 * entrevista NÃO inicia — o app trava ali e ensina a consertar. */
const gpsValido = () => !!S.fix && !fixVelho();
function modalGpsBloqueio(aoConsertar) {
  const negado = S.gpsErro === 1;
  const corpo = negado
    ? `<p style="font-size:18px"><b>O app está sem PERMISSÃO de localização.</b></p>
       <p>1. Toque no <b>cadeado</b> (ou ⋮) na barra do navegador<br>
          2. <b>Permissões</b> → <b>Local</b> → <b>Permitir</b><br>
          3. Se o app está instalado: segure o ícone dele → <b>Informações</b> → <b>Permissões</b> → <b>Local</b> → Permitir</p>
       <p class="dica">Depois volte aqui e toque no botão verde.</p>`
    : `<p style="font-size:18px"><b>O GPS está desligado ou ainda sem sinal.</b></p>
       <p>1. Puxe a barra de cima do celular e <b>ligue a Localização</b> 📍<br>
          2. Fique em <b>céu aberto</b> (fora de carro/telhado)<br>
          3. Aguarde uns 30 segundos</p>
       <p class="dica">O GPS funciona sem internet — é satélite.</p>`;
  return modal({
    titulo: '📍 Sem GPS não tem pesquisa',
    corpo,
    acoes: [{ id: 'de-novo', rotulo: '✓ Já consertei — tentar de novo', estilo: 'b-primario' }],
  }).then(() => new Promise((res) => {
    navigator.geolocation.getCurrentPosition(
      (p) => {
        S.gpsErro = 0;
        S.fix = { lat: p.coords.latitude, lon: p.coords.longitude, acc: p.coords.accuracy,
                  ts: new Date(p.timestamp).toISOString(), fonte: p.coords.accuracy <= 100 ? 'gps' : 'rede' };
        pintarCabecalho(); toast('📍 GPS ok!', 'ok');
        res(aoConsertar ? aoConsertar() : true);
      },
      () => { toast('Ainda sem GPS — confira os passos.', 'erro'); res(modalGpsBloqueio(aoConsertar)); },
      { enableHighAccuracy: true, maximumAge: 0, timeout: 20000 }
    );
  }));
}
function badgeGps() {
  if (!S.fix) return '<span class="gps cinza">GPS sem fix</span>';
  const c = classificarAccuracy(S.fix.acc);
  const v = fixVelho() ? ' · fix &gt;120s' : '';
  return `<span class="gps ${c.cor}">📍 ±${Math.round(S.fix.acc)} m${v}</span>`;
}

/* ---- "estou na área certa?" (§ item 2): badge + convite de 1 toque, nunca bloqueio */
function badgePosto() {
  const a = avaliarPosicao(S.fix, S.ponto, S.pontos);
  if (a.dist_m === null) return '';
  if (!a.longe) return `<span class="gps verde">✓ no ponto · ${a.dist_m} m</span>`;
  return `<span class="gps amarelo">a ${a.dist_m} m do ponto</span>`;
}

/** Se o ponto mais próximo não é o selecionado E o selecionado está longe, oferece a troca. */
function avisoPontoErrado() {
  const a = avaliarPosicao(S.fix, S.ponto, S.pontos);
  if (!a.sugestao) return '';
  return `<div class="aviso" id="troca-ponto">
    Você parece estar em <b>${esc(a.sugestao.ponto_id)} · ${esc(a.sugestao.nome)}</b>
    (${a.sugestao.dist_m} m daqui, contra ${a.dist_m} m do ponto selecionado).
    <button class="b-primario" id="troca-ok" style="margin-top:.5rem">Trocar para cá</button></div>`;
}
function ligarTrocaPonto() {
  const b = el('troca-ok');
  if (!b) return;
  b.onclick = () => {
    const a = avaliarPosicao(S.fix, S.ponto, S.pontos);
    if (!a.sugestao) return;
    trocarPonto(a.sugestao);
  };
}
/** Troca o ponto SEM apagar a entrevista em curso (só recarimba a que ponto ela pertence). */
function trocarPonto(p) {
  S.ponto = S.pontos.find((x) => x.ponto_id === p.ponto_id) || p;
  if (S.r) {
    S.r.ponto_id = S.ponto.ponto_id; S.r.ponto_nome = S.ponto.nome; S.r.ponto_tipo = S.ponto.tipo;
    if (S.fix) S.r.distancia_ao_ponto_m = haversine(S.fix.lat, S.fix.lon, S.ponto.lat, S.ponto.lon);
  }
  toast(`Ponto trocado para ${S.ponto.ponto_id} · ${S.ponto.nome}.`, 'ok');
  pintarCabecalho(); render();
}

async function wakeOn() {
  try { if ('wakeLock' in navigator && !S.wakeLock) S.wakeLock = await navigator.wakeLock.request('screen'); } catch {}
}
async function wakeOff() { try { await S.wakeLock?.release(); } catch {} S.wakeLock = null; }
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && S.r) wakeOn();
});

/* ================================================================ dados */
async function carregarJson(caminho, chaveCache) {
  try {
    const r = await fetch(caminho, { cache: 'no-store' });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const j = await r.json();
    await metaSet(chaveCache, j);
    return j;
  } catch {
    const c = await metaGet(chaveCache);
    if (c) return c;
    throw new Error('sem rede e sem cache para ' + caminho);
  }
}

async function carregarDados() {
  const [pt, sc, al] = await Promise.all([
    carregarJson('./data/pontos.json', 'cache_pontos'),
    carregarJson('./data/schema.json', 'cache_schema'),
    carregarJson('./data/alias.json', 'cache_alias').catch(() => ({})),
  ]);
  S.pontos = pt.pontos; S.alias = al || {};

  /* Congelamento de schema: só troca de versão com a fila VAZIA (§7.7) */
  const anterior = await metaGet('schema_ativo');
  const fila = await contarFila();
  if (anterior && anterior.schema_version !== sc.schema_version && fila > 0) {
    S.schema = anterior;
    toast(`Schema ${sc.schema_version} disponível — troca quando a fila zerar (${fila} pendente).`);
  } else {
    S.schema = sc; await metaSet('schema_ativo', sc);
  }

  /* pesados: cache-first via SW, tolerantes a falha */
  try { S.localidades = await carregarJson('./data/localidades.json', 'cache_loc'); } catch { S.localidades = { bairros_urbanos: [], localidades_rurais: [], municipios_vizinhos: [] }; }
  try { S.pois = (await carregarJson('./data/pois.json', 'cache_pois')).pois || []; } catch { S.pois = []; }
  try {
    const g = await carregarJson('./data/ruas_rbs.geojson', 'cache_ruas');
    S.vias = g.vias_index || []; S.limiteRing = g.limite_ring || null; S.geo = g;
  } catch { S.vias = []; }

  const rod = S.schema.rodape || {};
  if (rod.atribuicao) el('rod-atrib').textContent = rod.atribuicao;
  if (rod.identificacao) el('rod-ident').textContent = rod.identificacao;
}

/* ================================================================ fila e sync */
async function contarFila() {
  const [a, b] = await Promise.all([todos('respostas'), todos('recusas')]);
  return [...a, ...b].filter((i) => i.status === 'pendente').length;
}
async function itensPendentes() {
  const [a, b] = await Promise.all([todos('respostas'), todos('recusas')]);
  return [...a.map((i) => ({ ...i, tipo: 'resposta' })), ...b.map((i) => ({ ...i, tipo: 'recusa' }))]
    .filter((i) => i.status === 'pendente')
    .sort((x, y) => (x.criado_em || '').localeCompare(y.criado_em || ''));
}
async function contarHoje() {
  const a = await todos('respostas');
  const d = hoje();
  return a.filter((i) => i.dia === d).length;
}

async function sincronizar(manual = false) {
  if (S.enviando || !S.sessao) return;
  if (!navigator.onLine && !manual) return;
  const pend = await itensPendentes();
  if (!pend.length) { if (manual) toast('Nada na fila. Tudo sincronizado.', 'ok'); return; }
  if (!API_URL) { if (manual) toast('API_URL não configurada (ver DEPLOY.md).', 'erro'); return; }

  S.enviando = true; el('h-sync').classList.add('enviando');
  try {
    const lote = montarLote(pend, LOTE_MAX);
    const agora = Date.now();
    lote.forEach((i) => { i.payload.fila_espera_min = filaEsperaMin(i.payload.ts_fim || i.payload.ts, agora); });

    const res = await enviarLote({
      fetchImpl: (...a) => fetch(...a),
      url: API_URL, token: S.sessao.token,
      pesquisador_id: S.sessao.pesquisador_id, device_id: S.sessao.device_id,
      app_version: APP_VERSION, itens: lote, fila_pendente: pend.length,
    });

    /* SOMENTE os uuids que voltaram em acked saem da fila (regra da casa) */
    for (const i of lote) {
      if (!res.sincronizados.includes(i.uuid)) continue;
      const store = i.tipo === 'recusa' ? 'recusas' : 'respostas';
      const reg = await tx(store, 'readonly', (s) => s.get(i.uuid));
      if (reg) { reg.status = 'sincronizado'; reg.ts_sync = new Date().toISOString(); await put(store, reg); }
    }
    /* o servidor devolve o quadro do time — é o que faz "aqui X/C" valer para todos */
    if (res.feito_pontos) await guardarFeitoPontos(res.feito_pontos);
    if (res.sincronizados.length) toast(`${res.sincronizados.length} enviado(s).`, 'ok');
    if (res.erro) { console.warn('[sync]', res.erro); if (manual) toast('Fila mantida: ' + res.erro, 'erro'); }
    else if (!res.sincronizados.length && manual) toast('Nada foi confirmado pelo servidor.', 'erro');
  } catch (e) {
    console.error(e); if (manual) toast('Falha no envio: ' + e.message, 'erro');
  } finally {
    S.enviando = false; el('h-sync').classList.remove('enviando');
    await pintarCabecalho();
    if (S.vista === 'fila') render();
  }
}

function ligarSync() {
  setInterval(() => sincronizar(false), SYNC_INTERVALO_MS);       // gatilho 2: timer 30 s
  window.addEventListener('online', () => { sincronizar(false); atualizarQuadro(); });  // gatilho 1: evento online
  el('h-sync').onclick = () => sincronizar(true);                 // gatilho 4: botão manual
  navigator.serviceWorker?.ready.then((reg) => {                  // gatilho 3: Background Sync (não-iOS)
    reg.sync?.register('od-sync').catch(() => {});
  }).catch(() => {});
  navigator.serviceWorker?.addEventListener('message', (e) => {   // o SW acorda o app após Background Sync
    if (e.data?.tipo === 'sincronize') sincronizar(false);
  });
}

/* ================================================================ cabeçalho (tela 0) */
/** Guarda o quadro do time que veio do servidor (login ou sync). */
async function guardarFeitoPontos(mapa) {
  if (!mapa || typeof mapa !== 'object') return;
  S.feitoPontos = { mapa, em: Date.now() };
  await metaSet('feito_pontos', S.feitoPontos);
}

/**
 * Quantas já foram feitas NESTE ponto, contando o time todo.
 * O servidor é a fonte; offline vale a contagem do próprio aparelho, e o cabeçalho
 * diz "(só meu)" para ninguém confundir a própria produção com a do ponto.
 */
function feitoNoPonto(ponto, respostas) {
  if (!ponto) return { n: 0, global: false };
  const d = hoje();
  const locais = respostas.filter((i) => i.dia === d && i.payload?.ponto_id === ponto.ponto_id).length;
  const fresco = !!(S.feitoPontos && Date.now() - S.feitoPontos.em < FEITO_VALIDADE_MS);
  const global = fresco ? Number(S.feitoPontos.mapa[ponto.ponto_id]) || 0 : 0;
  return { n: Math.max(global, locais), global: fresco };
}

async function pintarCabecalho() {
  _pinturaGps = Date.now();
  if (!S.sessao) { el('hdr').hidden = true; return; }
  el('hdr').hidden = false;
  /* uma leitura só das duas stores alimenta fila + dia + ponto (antes eram três) */
  const [resp, rec] = await Promise.all([todos('respostas'), todos('recusas')]);
  const d = hoje();
  S.fila = [...resp, ...rec].filter((i) => i.status === 'pendente').length;
  S.contDia = resp.filter((i) => i.dia === d).length;

  el('h-pesq').textContent = S.sessao.pesquisador_id;
  /* modo gestor é só do G01. Optional chaining de propósito: se um index.html velho ficar
     em cache sem este botão, o cabeçalho inteiro deixaria de pintar num TypeError. */
  const btEquipe = el('h-equipe');
  if (btEquipe) btEquipe.hidden = !ehGestor();
  el('h-ponto').textContent = S.ponto ? S.ponto.ponto_id : '— ponto —';
  el('h-nome').textContent = S.ponto ? S.ponto.nome : 'selecione';

  const cota = Number(S.ponto?.meta_entrevistas) || 0;
  const aqui = feitoNoPonto(S.ponto, resp);
  const c = avaliarCota(aqui.n, cota);
  const eAqui = el('h-aqui');
  eAqui.textContent = S.ponto ? `aqui ${aqui.n}/${cota || '—'}${aqui.global ? '' : ' só meu'}` : 'aqui —';
  eAqui.className = 'cont aqui' + (c.estado === 'completa' ? ' ok' : c.estado === 'excedida' ? ' alerta' : '');
  eAqui.title = S.ponto
    ? `${aqui.n} de ${cota} no ponto ${S.ponto.ponto_id}` +
      (aqui.global ? ' (time todo)' : ' — sem quadro do servidor há mais de 2 h: só este aparelho')
    : '';

  el('h-cont').textContent = `dia ${S.contDia}/${S.sessao.meta_dia || '—'}`;
  el('h-fila').textContent = S.fila;
  el('h-sync').classList.toggle('pendente', S.fila > 0);
  el('h-sync').title = S.fila ? `Sincronizar agora (${S.fila} na fila)` : 'Tudo sincronizado';

  /* avisa UMA vez por mudança de estado — o cabeçalho repinta a cada fix de GPS */
  if (S.ponto && S.cotaAvisada[S.ponto.ponto_id] !== c.estado) {
    S.cotaAvisada[S.ponto.ponto_id] = c.estado;
    if (c.estado === 'completa')
      toast(`Cota de ${S.ponto.ponto_id} completa (${aqui.n}/${cota}) — pode estender até +30% se o fluxo estiver bom (G3).`, 'ok');
    else if (c.estado === 'excedida')
      toast(`${S.ponto.ponto_id} passou de 130% da cota (${aqui.n}/${cota}). Migre para o ponto vizinho mais atrasado.`, 'erro');
  }
}

/* ================================================================ router */
const topo = () => { document.body.scrollTo(0, 0); window.scrollTo(0, 0); };  // body e o rolador (24/08)
function irPara(vista) { S.vista = vista; render(); topo(); }

function render() {
  switch (S.vista) {
    case 'login': return vLogin();
    case 'ponto': return vPonto();
    case 'entrevista': return vTela();
    case 'recusa': return vRecusa();
    case 'fila': return vFila();
    case 'gestao': return vGestao();
    default: return;
  }
}

/* ================================================================ LOGIN (uma vez, com sinal)
 * SEM TOKEN NA TELA (decisão do dono, 24/08: equipe inexperiente, zero fricção).
 * O token continua existindo por baixo: o servidor o entrega no 1º login
 * (action login_simples) e o app o envia em todo lote — o humano nunca o vê. */
function vLogin() {
  el('hdr').hidden = true;
  main().innerHTML = `
    <h1>Pesquisa Origem-Destino<br>Rio Branco do Sul</h1>
    <p class="dica">Toque no seu nome e digite seu <b>PIN de 4 números</b> — no último
    número ele entra sozinho. É só na primeira vez — depois o aplicativo funciona até sem internet.</p>
    ${blocoInstalar()}
    <div id="l-lista" class="lista-nomes"></div>
    <div id="l-pin" hidden>
      <h3 id="l-pin-t"></h3>
      <div class="pin-dots" id="l-dots"><i></i><i></i><i></i><i></i></div>
      <div class="teclado" id="l-tec"></div>
      <!-- o botão vive DENTRO do bloco do PIN: abaixo dele ficava fora da tela
           do celular e o 4º dígito "não fazia nada" (Luiz, 24/08 19h) -->
      <div class="acoes"><button id="l-ok" class="b-primario" disabled>Começar</button></div>
    </div>
    <div id="l-msg"></div>
    <p class="dica" style="margin-top:1.2rem">Versão ${esc(APP_VERSION)} · schema ${esc(S.schema?.schema_version || '—')}</p>`;
  ligarInstalar();

  /* Teclado NUMÉRICO próprio: o teclado do sistema abre no modo texto, come metade da tela
     e ainda oferece autocorreção. Aqui são 12 alvos grandes e nada mais. */
  let pin = '';
  const dots = () => [...el('l-dots').children].forEach((d, i) =>
    d.classList.toggle('on', i < pin.length));
  const conferePin = () => { el('l-ok').disabled = pin.length !== 4; dots(); };
  const tecla = (t, cls) => `<button type="button" class="tecla ${cls || ''}" data-k="${t}">${t}</button>`;
  el('l-tec').innerHTML =
    ['1', '2', '3', '4', '5', '6', '7', '8', '9'].map((n) => tecla(n)).join('') +
    tecla('⌫', 'apaga') + tecla('0') + '<span></span>';
  el('l-tec').querySelectorAll('[data-k]').forEach((b) => b.onclick = () => {
    const k = b.dataset.k;
    if (k === '⌫') pin = pin.slice(0, -1);
    else if (pin.length < 4) pin += k;
    el('l-msg').innerHTML = '';
    conferePin();
    /* 4º dígito entra SOZINHO (180ms para a 4ª bolinha pintar antes do "Entrando…").
       O botão Começar continua como reserva — mesma função, sem duplo disparo. */
    if (pin.length === 4) setTimeout(entrar, 180);
  });

  const lista = el('l-lista'); let escolhido = '';
  /* o GESTOR vai para o FIM da lista e fica marcado: em campo, o toque errado no primeiro
     nome da lista fazia o entrevistador entrar como coordenador (Luiz, 24/08) */
  const ordenada = [...(S.equipe || [])].sort(
    (a, b) => (a.pesq_id === GESTOR ? 1 : 0) - (b.pesq_id === GESTOR ? 1 : 0));
  ordenada.forEach((p) => {
    const eGestor = p.pesq_id === GESTOR;
    const b = document.createElement('button'); b.type = 'button';
    if (eGestor) b.className = 'gestor';
    b.innerHTML = `${esc(p.nome)}<span class="sub">${
      eGestor ? 'GESTOR — só o coordenador usa' : esc(p.pesq_id)}</span>`;
    b.onclick = () => {
      escolhido = p.pesq_id;
      [...lista.children].forEach((x) => x.classList.remove('sel'));
      b.classList.add('sel');
      pin = '';
      el('l-pin').hidden = false;
      el('l-pin-t').textContent = `PIN de ${p.nome.split(' ')[0]}`;
      el('l-msg').innerHTML = '';
      conferePin();
      el('l-pin').scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    };
    lista.appendChild(b);
  });

  let entrando = false;
  const entrar = async () => {
    if (entrando) return;                       // 4º dígito + toque no botão = 1 login só
    const msg = el('l-msg');
    if (!escolhido) { msg.innerHTML = '<div class="aviso erro">Toque no seu nome primeiro.</div>'; return; }
    if (pin.length !== 4) { msg.innerHTML = '<div class="aviso erro">Digite os 4 números do seu PIN.</div>'; return; }
    if (!API_URL) { msg.innerHTML = '<div class="aviso erro">API_URL não configurada neste build (ver DEPLOY.md).</div>'; return; }
    entrando = true;
    el('l-ok').disabled = true;
    msg.innerHTML = '<div class="aviso">Entrando…</div>';
    try {
      const r = await fetch(API_URL, {
        method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' },
        body: JSON.stringify({ action: 'login_simples', pesquisador_id: escolhido, pin,
                               app_version: APP_VERSION, device_id: await deviceId() }),
      });
      const j = JSON.parse(await r.text());
      if (!j.ok) {
        /* PIN errado: limpa os 4 dígitos para a pessoa digitar de novo sem apagar um a um */
        pin = ''; conferePin(); entrando = false;
        msg.innerHTML = `<div class="aviso erro">${esc(j.erro || 'Não deu para entrar — chame o coordenador.')}</div>`;
        return;
      }
      S.sessao = {
        pesquisador_id: j.pesquisador_id, nome: j.nome, token: j.token,
        validade: j.token_validade, meta_dia: j.meta_dia, device_id: await deviceId(),
        entrou_em: new Date().toISOString(),
      };
      await metaSet('sessao', S.sessao);           // <- nunca mais pede, mesmo em modo avião
      await guardarFeitoPontos(j.feito_pontos);    // o dia começa com o quadro atual do time
      toast(`Bem-vindo(a), ${j.nome}.`, 'ok');
      await pintarCabecalho(); irPara('ponto');
    } catch (e) {
      entrando = false;
      el('l-ok').disabled = false;
      msg.innerHTML = `<div class="aviso erro">Sem internet agora. A primeira entrada precisa de sinal — depois nunca mais.<br><small>${esc(e.message)}</small></div>`;
    }
  };
  el('l-ok').onclick = entrar;
}

async function deviceId() {
  let d = await metaGet('device_id');
  if (!d) { d = 'DV-' + novoUuid().slice(0, 8); await metaSet('device_id', d); }
  return d;
}

/* ================================================================ SELEÇÃO DE PONTO */
function vPonto() {
  const lista = ordenarPontosPorDistancia(S.pontos.filter((p) => p.ativo !== false), S.fix);
  main().innerHTML = `
    <h2 class="pergunta">Em qual ponto você está?</h2>
    <p>${badgeGps()} <span class="dica">lista ordenada pelo mais próximo</span></p>
    ${!gpsValido() ? `<div class="aviso erro"><b>📍 GPS desligado ou sem sinal.</b> A pesquisa
      <b>não inicia</b> sem localização — conserte antes de abordar alguém.
      <div class="acoes" style="margin-top:.5rem"><button id="p-gps" class="b-primario">Consertar o GPS agora</button></div></div>` : ''}
    <ul class="lista" id="p-lista"></ul>
    <!-- esta tela é a "casa" e não tem Voltar: sem uma saída escrita, o ☰ sozinho no
         cabeçalho é invisível para quem nunca usou o app (Luiz, 24/08) -->
    <button class="b-fantasma b-grande" id="p-menu" style="text-align:center;margin-top:.6rem">
      ☰ Menu · sair, sincronizar, instalar</button>`;
  const ul = el('p-lista');
  const bGps = el('p-gps');
  if (bGps) bGps.onclick = () => modalGpsBloqueio(() => irPara('ponto'));  // consertou → re-renderiza já ordenado
  const fresco = !!(S.feitoPontos && Date.now() - S.feitoPontos.em < FEITO_VALIDADE_MS);
  lista.forEach((p) => {
    const li = document.createElement('li');
    const b = document.createElement('button'); b.className = 'item';
    const d = p.dist_m === null ? '—' : p.dist_m < 1000 ? `${p.dist_m} m` : `${(p.dist_m / 1000).toFixed(1)} km`;
    /* feito/meta do TIME: é assim que se escolhe "o vizinho mais atrasado" sem adivinhar */
    const f = fresco ? Number(S.feitoPontos.mapa[p.ponto_id]) || 0 : null;
    const est = f === null ? '' : avaliarCota(f, p.meta_entrevistas).estado;
    b.innerHTML = `<span class="d">${esc(d)}</span>
      <span class="n"><b>${esc(p.ponto_id)} · ${esc(p.nome)}</b>
      <small>${esc(p.bairro)} · ${p.tipo === 'rural' ? 'rural ' + esc(p.rota) : 'urbano · Tier ' + esc(p.tier)}</small></span>
      <span class="m${est === 'completa' ? ' ok' : est === 'excedida' ? ' cheio' : ''}">${
        f === null ? 'meta ' + p.meta_entrevistas : f + '/' + p.meta_entrevistas}</span>`;
    b.onclick = () => { S.ponto = p; pintarCabecalho(); novaEntrevista(); };
    li.appendChild(b); ul.appendChild(li);
  });
  el('p-menu').onclick = () => irPara('fila');
}

/* ================================================================ ENTREVISTA */
function telasAtivas() {
  return S.schema.telas.filter((t) => {
    if (!t.condicional) return true;
    if (t.condicional.includes('transbordo')) return S.ponto?.transbordo === true;
    if (t.condicional.includes('modal')) return S.r?.modal === 'onibus';   // v1.0: acesso_onibus
    return true;
  });
}

function novaEntrevista() {
  S.r = {
    uuid: novoUuid(), schema_version: S.schema.schema_version, app_version: APP_VERSION,
    pesquisador_id: S.sessao.pesquisador_id, device_id: S.sessao.device_id,
    ponto_id: S.ponto.ponto_id, ponto_nome: S.ponto.nome, ponto_tipo: S.ponto.tipo,
    qc_status: 'ok', qc_flags: '', consentimento_verbal: false,
  };
  /* padrões vindos do schema (v1.0: entrevistado_tipo = circulando já pré-selecionado —
     a exceção é o comerciante, e um toque a mais em 350 entrevistas custa caro) */
  for (const t of S.schema.telas) {
    for (const g of (t.grupos || [])) if (g.padrao !== undefined) S.r[g.campo] = g.padrao;
    /* campos de `texto_extra` nascem vazios: o ensureColumns do servidor cria coluna a
       partir das CHAVES do payload, então a coluna existe já no 1º envio do dia mesmo
       que ninguém tenha respondido "Outro" ainda (schema 1.1). */
    for (const o of (t.opcoes || [])) if (o.texto_extra) S.r[o.texto_extra.campo] = '';
  }
  S.tela = 0; irPara('entrevista');
}

function proximaTela() {
  const ts = telasAtivas();
  if (S.tela >= ts.length - 1) return;
  S.tela++; render(); topo();
}
/** Tem resposta dentro? Serve para não perguntar "descartar?" numa entrevista em branco. */
const entrevistaComecou = () => !!(S.r && (S.r.consentimento_verbal === true ||
  S.r.modal || S.r.origem_nivel || S.r.destino_nivel || S.r.origem_motivo));

async function telaAnterior() {
  if (S.tela === 0) {
    if (entrevistaComecou()) {
      const q = await modal({
        titulo: 'Descartar esta entrevista?',
        corpo: '<p>O que já foi respondido <b>não será gravado</b>. As entrevistas ' +
               'anteriores continuam salvas.</p>',
        acoes: [{ id: 'nao', rotulo: 'Continuar entrevista', estilo: 'b-primario' },
                { id: 'sim', rotulo: 'Descartar', estilo: 'b-recusa' }],
      });
      if (q !== 'sim') return;
    }
    S.r = null; wakeOff(); irPara('ponto'); return;
  }
  S.tela--; render(); topo();
}

function barraProgresso() {
  const ts = telasAtivas();
  return `<div class="prog">${ts.map((_, i) => `<i class="${i <= S.tela ? 'on' : ''}"></i>`).join('')}</div>`;
}
const btVoltar = '<button class="b-voltar" id="bt-voltar">‹ Voltar</button>';
function ligarVoltar() { const b = el('bt-voltar'); if (b) b.onclick = telaAnterior; }

function vTela() {
  const t = telasAtivas()[S.tela];
  if (!t) { S.tela = 0; return; }
  const m = main();
  m.innerHTML = barraProgresso();
  const box = document.createElement('div'); m.appendChild(box);
  ({
    abordagem: telaAbordagem, cascata: telaCascata, chips: telaChips,
    trecho: telaTrecho, grupo_chips: telaPerfil, resumo: telaResumo,
  }[t.tipo] || telaDesconhecida)(box, t);
}
const telaDesconhecida = (box, t) => (box.innerHTML = `<div class="aviso erro">Tela "${esc(t.tipo)}" não implementada.</div>` + btVoltar, ligarVoltar());

/* ---- tela 1: abordagem (carimba ts_inicio) */
function telaAbordagem(box, t) {
  const nome = S.sessao.nome.split(' ')[0];
  box.innerHTML = `
    <h2 class="pergunta">${esc(t.titulo)}</h2>
    <div class="resumo"><div style="padding:.6rem 0">
      ${t.script.map((l) => `<p>${esc(l.replace('[NOME]', nome))}</p>`).join('')}
    </div></div>
    <p>${badgeGps()} ${badgePosto()}</p>
    ${avisoPontoErrado()}
    <div class="acoes">
      <button class="b-primario" id="a-ok" style="min-height:64px">Aceitou</button>
      <button class="b-recusa" id="a-no" style="min-height:64px">Recusa</button>
    </div>
    <div style="margin-top:1rem">${btVoltar}</div>`;
  const aceitar = () => {
    S.r.consentimento_verbal = true;
    S.r.ts_inicio = new Date().toISOString();          // <- definição travada no dicionário
    carimbarGps();
    wakeOn();
    proximaTela();
  };
  el('a-ok').onclick = () => {
    /* GATE DURO: sem fix fresco a entrevista não começa (dono, 24/08) */
    if (!gpsValido()) { modalGpsBloqueio(aceitar); return; }
    aceitar();
  };
  el('a-no').onclick = async () => {
    const q = await modal({
      titulo: 'Registrar recusa?',
      corpo: '<p>Use quando a pessoa <b>não quis</b> responder. Na próxima tela você marca o motivo.</p>',
      acoes: [{ id: 'nao', rotulo: 'Voltar' }, { id: 'sim', rotulo: 'Sim', estilo: 'b-recusa' }],
    });
    if (q === 'sim') irPara('recusa');
  };
  ligarTrocaPonto();
  ligarVoltar();
}

function carimbarGps() {
  if (S.fix) {
    S.r.abordagem_lat = +S.fix.lat.toFixed(6); S.r.abordagem_lon = +S.fix.lon.toFixed(6);
    S.r.abordagem_accuracy_m = Math.round(S.fix.acc);
    S.r.abordagem_gps_ts = S.fix.ts; S.r.gps_fonte = S.fix.fonte;
    S.r.distancia_ao_ponto_m = haversine(S.fix.lat, S.fix.lon, S.ponto.lat, S.ponto.lon);
  } else {
    S.r.gps_fonte = 'ausente'; S.r.distancia_ao_ponto_m = '';
  }
}

/* ---- telas 2 e 3: cascata origem / destino */
/* Mínimo de letras para oferecer "Usar como digitei". Fica ACIMA do min_chars=2 do
   autocomplete de propósito: com 2 letras o entrevistador ainda está digitando, e um
   logradouro de 2 letras não é geocodificável por ninguém. Não vem do schema.json — o
   schema é network-first e mudar isso em campo mudaria a REGRA de gravação, não um rótulo. */
const MIN_VIA_MANUAL = 3;
function telaCascata(box, t) {
  const p = t.prefixo, casc = S.schema.cascata;
  const jaTem = S.r[p + '_nivel'];
  box.innerHTML = `
    <h2 class="pergunta">${esc(t.titulo)}</h2>
    ${/* Linha de contexto (0.9.17): o aviso do V08 só aparece no modal do salvar, quando a
          pessoa entrevistada JÁ FOI EMBORA e não há mais como perguntar de novo — está
          estruturalmente condenado a ser ignorado. Esta linha chega com a pessoa presente,
          que é o único momento em que o dado ainda pode ser corrigido. É uma linha no
          template que já existe: não cria tela, ramo de navegação nem toque. */
      /* `!jaTem` não é detalhe: medido no Pages a 360x640 (Android básico da equipe), a linha
         custa 58 px e empurra o "Seguir" para exatamente a dobra. Com o destino JÁ registrado
         o bloco "Registrado:" ainda se soma a ela, e o Seguir — único caminho adiante quando
         se volta pelo "‹ Voltar" — sai da tela. Foi esse o bug do D1 ("deu OK e voltou pra
         origem"). A linha serve para preparar a pergunta ANTES de gravar o destino; depois de
         gravado ela não informa mais nada e só ocupa a altura que falta. */
      p === 'destino' && S.r.origem_nivel && !jaTem
        ? `<p class="ctx-origem">Origem: <b>${esc(resumoLocal('origem'))}</b> — o destino tem de ser OUTRO lugar</p>` : ''}
    ${jaTem ? `<div class="aviso ok">Registrado: <b>${esc(resumoLocal(p))}</b> (nível ${jaTem})</div>` : ''}
    ${(t.atalhos || []).length ? `<div class="chips c2" id="c-atalhos">${t.atalhos.map((a) =>
      `<button class="chip" data-a="${esc(a.id)}">${esc(a.rotulo)}</button>`).join('')}</div><div style="height:.6rem"></div>` : ''}
    <div id="c-botoes"></div>
    <div id="c-area"></div>
    <div class="acoes" style="margin-top:.4rem">
      ${btVoltar}
      <button class="b-primario" id="c-seguir" ${jaTem ? '' : 'disabled'}>Seguir ›</button>
    </div>
    <p class="dica" style="margin-top:.6rem">Escada 1→2→3→4→5→6. Nunca pule um degrau sem oferecer o de baixo.</p>`;

  const bs = el('c-botoes');
  casc.botoes.forEach((b) => {
    const bt = document.createElement('button');
    bt.className = 'b-grande';
    bt.innerHTML = `<span style="font-size:22px">${b.i}</span> ${esc(p === 'destino' && b.rotulo_destino ? b.rotulo_destino : b.rotulo)}`;
    bt.onclick = () => abrirModoCascata(b, p);
    bs.appendChild(bt);
  });

  box.querySelectorAll('#c-atalhos [data-a]').forEach((b) => {
    b.onclick = () => {
      if (b.dataset.a === 'copiar_origem') {
        for (const c of ['nivel', 'municipio', 'bairro', 'logradouro', 'numero', 'referencia',
                         'lat', 'lon', 'precisao_m', 'metodo', 'zona', 'zona_fina'])
          S.r['destino_' + c] = S.r['origem_' + c];
        toast('Origem copiada para o destino.');
      } else {
        S.r.destino_referencia = 'residência do entrevistado';
        if (!S.r.destino_nivel) { S.r.destino_nivel = 5; S.r.destino_metodo = 'texto_livre'; S.r.destino_precisao_m = 800; }
      }
      render();
    };
  });
  el('c-seguir').onclick = proximaTela;
  ligarVoltar();
}

function resumoLocal(p) {
  const r = S.r;
  return [r[p + '_logradouro'], r[p + '_numero'], r[p + '_referencia'], r[p + '_bairro'], r[p + '_municipio']]
    .filter(Boolean).join(', ') || '—';
}
/* gravarLocal(p, dados, seguir)
 * `seguir` = este caminho FECHA a tela: avança sozinho, como os chips (0.9.15).
 * Motivo (bug de campo D1, dois celulares travados): registrar rua+número re-renderizava
 * a cascata com o aviso "Registrado" e o botão Seguir ABAIXO DA DOBRA — para o
 * entrevistador, "deu OK e voltou pra origem". Nenhum registro pode depender de um botão
 * que talvez não esteja na tela. O estado "Registrado" continua existindo: reaparece no
 * Voltar, para reconferência — só deixou de ser parada obrigatória.
 * `seguir` falso mantém o comportamento antigo (re-render) para quem NÃO fecha a tela.
 * `dados.zona` explícito vence o zonaDe() automático (caso do outro município). */
function gravarLocal(p, dados, seguir) {
  Object.entries(dados).forEach(([k, v]) => (S.r[p + '_' + k] = v));
  if (!S.r[p + '_municipio']) S.r[p + '_municipio'] = 'Rio Branco do Sul';
  if (dados.zona === undefined) S.r[p + '_zona'] = zonaDe(p);
  if (seguir) proximaTela(); else render();      // proximaTela já re-renderiza e sobe a tela
}
function zonaDe(p) {
  const b = normalizar(S.r[p + '_bairro'] || '');
  if (!b) return '';
  const m = S.pontos.find((x) => normalizar(x.bairro) === b);
  if (m) return m.zona;
  const mun = normalizar(S.r[p + '_municipio'] || '');
  return mun && mun !== normalizar('Rio Branco do Sul') ? 'ZE01' : '';
}

function abrirModoCascata(b, p) {
  const area = el('c-area'); area.innerHTML = '';
  const casc = S.schema.cascata;

  if (b.id === 'gps_perto') {
    if (!S.fix) { toast('Sem fix de GPS agora — use outra opção.', 'erro'); return; }
    gravarLocal(p, { nivel: 1, metodo: 'gps_entrevistado', precisao_m: Math.max(10, Math.round(S.fix.acc)),
                     lat: +S.fix.lat.toFixed(6), lon: +S.fix.lon.toFixed(6),
                     bairro: S.ponto.bairro, municipio: 'Rio Branco do Sul' }, true);
    toast('Coordenada atual registrada (nível 1).', 'ok');   // o toast flutua: sobrevive à troca de tela
    return;
  }

  if (b.id === 'buscar_via') {
    area.innerHTML = `
      <div class="abas">
        <button data-t="via" aria-selected="true">Ruas (${S.vias.length})</button>
        <button data-t="bairro" aria-selected="false">Bairro / localidade</button>
      </div>
      <input id="q" type="search" placeholder="digite 2 letras…" autocomplete="off" autocapitalize="words">
      <ul class="sug" id="sug"></ul>`;
    let aba = 'via';
    const q = el('q'), sug = el('sug');
    area.querySelectorAll('.abas button').forEach((bt) => bt.onclick = () => {
      aba = bt.dataset.t;
      area.querySelectorAll('.abas button').forEach((x) => x.setAttribute('aria-selected', x === bt));
      q.value = ''; sug.innerHTML = ''; q.focus();
    });
    let deb;
    q.oninput = () => {
      clearTimeout(deb);
      deb = setTimeout(() => {
        sug.innerHTML = '';
        if (aba === 'via') {
          const cru = q.value.trim();
          const res = buscarVias(S.vias, q.value, casc.autocomplete.top);
          res.forEach((v) => sug.appendChild(itemSug(v.n, 'via de Rio Branco do Sul', () => pedirNumero(p, v))));
          /* SAÍDA MANUAL (0.9.16) — sempre a partir de 3 letras, INCLUSIVE quando há resultados:
             o OSM só tem 220 vias do município, e quando tem, o "parecido" às vezes não é o
             certo. Sem esta linha o entrevistador é empurrado para bairro/referência e o NOME
             da rua que a pessoa falou SE PERDE — é o dado mais caro da cascata. Aqui ele vira
             logradouro de verdade, sem coordenada: nível 3, `texto_livre`, o gabinete
             geocodifica depois. Fica por último na lista, de propósito: o cadastro vem antes. */
          if (cru.length >= MIN_VIA_MANUAL)
            sug.appendChild(itemSug(`✏️ Usar como digitei: “${cru}”`,
              'logradouro sem coordenada — o gabinete localiza depois',
              () => pedirNumero(p, { n: cru, lat: null, lon: null, f: 'manual' }), 'manual'));
          else if (!res.length && normalizar(q.value).length >= 2)
            sug.innerHTML = '<li class="dica">Nada encontrado. Digite mais uma letra para usar o texto como está, ou tente a aba Bairro/localidade.</li>';
        } else {
          const todas = [...(S.localidades.bairros_urbanos || []), ...(S.localidades.localidades_rurais || [])];
          buscarVias(todas.map((x) => ({ ...x, n: x.nome })), q.value, 8)
            .forEach((v) => sug.appendChild(itemSug(v.nome, v.tipo, () => {
              gravarLocal(p, { nivel: casc.so_bairro_nivel, metodo: 'texto_livre',
                precisao_m: casc.so_bairro_precisao_m, bairro: v.nome, logradouro: '', numero: '',
                lat: v.lat, lon: v.lon, municipio: 'Rio Branco do Sul' }, true);
            })));
        }
      }, casc.autocomplete.debounce_ms);
    };
    q.focus();
    return;
  }

  if (b.id === 'poi') {
    area.innerHTML = `<input id="q" type="search" placeholder="posto, escola, mercado…" autocomplete="off">
                      <ul class="sug" id="sug"></ul>`;
    const q = el('q'), sug = el('sug');
    const pinta = (lista) => {
      sug.innerHTML = '';
      lista.slice(0, 10).forEach((x) => sug.appendChild(itemSug(x.nome, x.bairro, () =>
        gravarLocal(p, { nivel: 4, metodo: 'poi', precisao_m: 120, referencia: x.nome,
          bairro: x.bairro, lat: x.lat, lon: x.lon, municipio: 'Rio Branco do Sul' }, true))));
    };
    pinta(ordenarPontosPorDistancia(S.pois, S.fix));
    let deb;
    q.oninput = () => { clearTimeout(deb); deb = setTimeout(() => {
      const t = normalizar(q.value);
      pinta(!t ? ordenarPontosPorDistancia(S.pois, S.fix)
               : S.pois.filter((x) => normalizar(x.nome).includes(t) || normalizar(x.bairro).includes(t)));
    }, casc.autocomplete.debounce_ms); };
    return;
  }

  if (b.id === 'mapa') {
    area.innerHTML = `<div id="mapa"></div>
      <p class="mira">Arraste o pino até onde a pessoa indicou. <b id="mapa-c">—</b></p>
      <button class="b-primario b-grande" id="mapa-ok" style="text-align:center">Usar este ponto</button>`;
    setTimeout(() => montarMapa(p), 40);
    return;
  }

  if (b.id === 'outro_municipio') {
    const viz = S.localidades.municipios_vizinhos || [];
    area.innerHTML = `
      <h3>Município</h3>
      <div class="chips c2" id="mun">${viz.map((m) => `<button class="chip" data-m="${esc(m)}">${esc(m)}</button>`).join('')}
        <button class="chip" data-m="__outro__">Outro…</button></div>
      <label for="ob">Bairro / localidade (opcional — sobe para nível 5)</label>
      <input id="ob" type="text" placeholder="ex.: Centro, Vila São Pedro">
      <button class="b-primario b-grande" id="om-ok" style="text-align:center;margin-top:.7rem">Registrar</button>`;
    let mun = '';
    area.querySelectorAll('#mun [data-m]').forEach((bt) => bt.onclick = async () => {
      area.querySelectorAll('#mun [data-m]').forEach((x) => x.setAttribute('aria-pressed', 'false'));
      if (bt.dataset.m === '__outro__') {
        const v = prompt('Nome do município:'); if (!v) return; mun = v.trim();
        bt.textContent = mun;
      } else mun = bt.dataset.m;
      bt.setAttribute('aria-pressed', 'true');
    });
    el('om-ok').onclick = () => {
      if (!mun) { toast('Escolha o município.', 'erro'); return; }
      const bairro = el('ob').value.trim();
      /* zona explícita no próprio `dados`: o zonaDe() automático devolveria '' sem bairro,
         e depois do avanço não há mais onde corrigir. */
      gravarLocal(p, { nivel: bairro ? 5 : 6, metodo: 'texto_livre', precisao_m: bairro ? 800 : 5000,
        municipio: mun, bairro, logradouro: '', numero: '', lat: '', lon: '', zona: 'ZE01' }, true);
    };
    return;
  }
}

function itemSug(titulo, sub, onClick, cls) {
  const li = document.createElement('li');
  const b = document.createElement('button');
  b.innerHTML = `${esc(titulo)}<small>${esc(sub || '')}</small>`;
  if (cls) li.className = cls;                 // `manual` = a única sugestão que não é do cadastro
  b.onclick = onClick; li.appendChild(b); return li;
}

function pedirNumero(p, via) {
  const casc = S.schema.cascata;
  /* via.f === 'manual' = texto do entrevistador, não linha do cadastro: não tem coordenada
     e o número não compra precisão nenhuma enquanto ninguém geocodificar. */
  const manual = via.f === 'manual';
  const area = el('c-area');
  area.innerHTML = `
    <div class="aviso ${manual ? '' : 'ok'}"><b>${esc(via.n)}</b>${manual
      ? '<br><small>rua digitada — sem coordenada; o gabinete localiza depois</small>' : ''}</div>
    <label for="num">${manual
      ? 'Número (ajuda o gabinete a achar; a rua digitada fica nível 3 de qualquer jeito)'
      : 'Número (deixe vazio se a pessoa não quiser dar — fica nível 3)'}</label>
    <div class="linha2">
      <input id="num" type="text" inputmode="numeric" placeholder="ex.: 1234 ou s/n">
      <button class="b-primario" id="num-ok">OK</button>
    </div>
    <label for="bai">Bairro</label>
    <input id="bai" type="text" list="l-bairros" value="${esc(S.ponto.bairro)}">
    <datalist id="l-bairros">${[...(S.localidades.bairros_urbanos || []), ...(S.localidades.localidades_rurais || [])]
      .map((x) => `<option value="${esc(x.nome)}">`).join('')}</datalist>`;
  el('num-ok').onclick = () => {
    const n = el('num').value.trim();
    if (n && !/^(\d{1,5}|s\/n|S\/N)$/.test(n)) { toast('Número: 1 a 5 dígitos ou s/n (V10).', 'erro'); return; }
    const comN = n && n.toLowerCase() !== 's/n';
    /* Rua digitada à mão: nível 3 mesmo COM número (sem coordenada não existe nível 2), e
       precisao_m vazia — quem preenche é o gabinete depois de geocodificar (então o metodo
       vira `geocod_posterior` lá, não aqui).
       lat/lon vão explicitamente VAZIOS, e não "de fora": deixar as chaves fora preservaria
       a coordenada de uma tentativa anterior da MESMA entrevista (ex.: "estou vindo daqui
       perto" e depois Voltar), e a linha sairia com `texto_livre` carimbado em cima de um
       GPS que não é dela — erro silencioso, o pior tipo. Vazio é o mesmo que o gabinete
       recebe hoje de "Outro município", que já grava lat:'' , lon:''. */
    gravarLocal(p, {
      nivel: manual ? 3 : (comN ? casc.com_numero_nivel : 3),
      metodo: manual ? 'texto_livre' : 'autocomplete_via',
      precisao_m: manual ? '' : (comN ? casc.com_numero_precisao_m : 150),
      logradouro: via.n, numero: n, bairro: el('bai').value.trim(),
      lat: manual ? '' : via.lat, lon: manual ? '' : via.lon,
      municipio: 'Rio Branco do Sul',
    }, true);
  };
  el('num').focus();
}

function montarMapa(p) {
  const centro = S.fix ? [S.fix.lat, S.fix.lon] : [S.ponto.lat, S.ponto.lon];
  if (S.mapa) { S.mapa.remove(); S.mapa = null; }
  /* mapa VETORIAL offline: nenhuma tile externa (Tile Usage Policy) */
  S.mapa = L.map('mapa', { zoomControl: true, attributionControl: false }).setView(centro, 15);
  if (S.geo?.features?.length)
    L.geoJSON({ type: 'FeatureCollection', features: S.geo.features },
      { style: { color: '#7f9c90', weight: 1.6 } }).addTo(S.mapa);
  if (S.limiteRing)
    L.polygon(S.limiteRing.map((c) => [c[1], c[0]]),
      { color: '#0b5c3f', weight: 2, fill: false, dashArray: '6 4' }).addTo(S.mapa);
  S.pontos.forEach((x) => L.circleMarker([x.lat, x.lon],
    { radius: 4, color: '#0b5c3f', fillColor: '#0b5c3f', fillOpacity: .65, weight: 1 })
    .bindTooltip(`${x.ponto_id} ${x.nome}`).addTo(S.mapa));

  S.marcador = L.marker(centro, { draggable: true }).addTo(S.mapa);
  const mostra = () => {
    const ll = S.marcador.getLatLng();
    el('mapa-c').textContent = `${ll.lat.toFixed(5)}, ${ll.lng.toFixed(5)}`;
  };
  S.marcador.on('move', mostra); S.mapa.on('click', (e) => { S.marcador.setLatLng(e.latlng); mostra(); });
  mostra();
  el('mapa-ok').onclick = () => {
    const ll = S.marcador.getLatLng();
    const fora = S.limiteRing && foraDoMunicipio(ll.lat, ll.lng, S.limiteRing);
    gravarLocal(p, { nivel: 1, metodo: 'pin_mapa', precisao_m: 10,
      lat: +ll.lat.toFixed(6), lon: +ll.lng.toFixed(6),
      municipio: fora ? '' : 'Rio Branco do Sul', bairro: '' }, true);
    /* pino fora do limite pode ser legítimo (viagem para outra cidade): avisa e segue —
       o toast de erro fica 5 s na tela e o Voltar corrige. Não trava a entrevista. */
    toast(fora ? 'Pino fora do limite municipal — confira no Voltar.' : 'Pino registrado (nível 1).', fora ? 'erro' : 'ok');
  };
  setTimeout(() => S.mapa.invalidateSize(), 120);
}

/* ---- telas 4, 5, 6: chips com avanço automático */
function telaChips(box, t) {
  const val = S.r[t.campo];
  box.innerHTML = `
    <h2 class="pergunta">${esc(t.titulo)}</h2>
    <div class="chips c${t.colunas || 2}" id="ch"></div>
    ${t.permite_outro ? `<div class="linha2" style="margin-top:.6rem">
        <input id="outro" type="number" inputmode="numeric" min="${t.min}" max="${t.max}" placeholder="${esc(t.outro_rotulo || 'Outro')}">
        <button class="b-primario" id="outro-ok">OK</button></div>` : ''}
    <div class="acoes">${btVoltar}</div>`;
  const c = el('ch');
  t.opcoes.forEach((o) => {
    const b = document.createElement('button');
    b.className = 'chip'; b.setAttribute('aria-pressed', String(val === o.v));
    b.innerHTML = (o.i ? `<span class="ic">${o.i}</span>` : '') + `<span>${esc(o.r)}</span>`;
    /* Chip com `texto_extra` (schema 1.1) NÃO avança direto: pergunta o complemento antes.
       Todo o resto continua com avanço automático de 1 toque, sem mudança nenhuma. */
    b.onclick = o.texto_extra
      ? () => perguntarTextoExtra(t, o)
      : () => { S.r[t.campo] = o.v; limparTextosExtras(t, o); proximaTela(); };
    c.appendChild(b);
  });
  if (t.permite_outro) el('outro-ok').onclick = () => {
    const v = Number(el('outro').value);
    if (!isFinite(v) || v < t.min || v > t.max) { toast(`Use ${t.min} a ${t.max} (V04).`, 'erro'); return; }
    S.r[t.campo] = v; proximaTela();
  };
  ligarVoltar();
}

/* Trocou de categoria: o complemento da OUTRA categoria não pode ficar pendurado
 * (ex.: escolheu "Outro/creche", voltou e escolheu "Casa" — o texto tem de sumir). */
function limparTextosExtras(t, escolhida) {
  for (const o of t.opcoes || [])
    if (o.texto_extra && o !== escolhida) S.r[o.texto_extra.campo] = '';
}

/* Complemento em TEXTO de um chip categórico (schema 1.1, pedido do dono em campo, D1).
 * Regra travada do projeto: a CATEGORIA continua sendo gravada no campo de sempre — a
 * matriz OD depende dela. O texto é COMPLEMENTO, em coluna própria (`texto_extra.campo`),
 * e NUNCA substitui a categoria. Genérico: vale para qualquer opção de qualquer tela de
 * chips que traga `texto_extra` no schema.
 * "Prefere não dizer" existe para não travar a entrevista — grava vazio e segue. */
async function perguntarTextoExtra(t, o) {
  const tx = o.texto_extra, max = tx.max || 120;
  const leia = () => (el('txe')?.value || '').trim().slice(0, max);
  const q = await modal({
    titulo: tx.pergunta || 'Qual?',
    corpo: `<p class="dica">Categoria <b>${esc(o.r)}</b> — anote com as palavras da pessoa.</p>
      <input id="txe" type="text" autocapitalize="sentences" autocomplete="off"
        autocorrect="off" spellcheck="false" enterkeyhint="done" maxlength="${max}"
        style="font-size:20px;min-height:56px"
        placeholder="${esc(tx.placeholder || 'ex.: levar filho na creche')}"
        value="${esc(S.r[tx.campo] || '')}">`,
    acoes: [
      { id: 'voltar', rotulo: '‹ Voltar' },
      { id: 'nao_diz', rotulo: 'Prefere não dizer' },
      {
        id: 'confirmar', rotulo: '✓ Confirmar', estilo: 'b-primario',
        valor: leia,
        trava: () => {                       // vazio: balança, avisa e FICA aberto
          if (leia()) return false;
          const i = el('txe');
          if (i) {
            if (i.animate) i.animate(
              [{ transform: 'translateX(0)' }, { transform: 'translateX(-9px)' },
               { transform: 'translateX(9px)' }, { transform: 'translateX(0)' }],
              { duration: 240, iterations: 2 });
            i.focus();
          }
          toast('Escreva o motivo — ou toque em "Prefere não dizer".', 'erro');
          return true;
        },
      },
    ],
    aoAbrir: () => { const i = el('txe'); if (i) { i.focus(); i.select(); } },
  });
  if (q === 'voltar') return;                 // não grava nada, fica na mesma tela
  S.r[t.campo] = o.v;                         // a CATEGORIA, sempre
  limparTextosExtras(t, o);
  S.r[tx.campo] = q === 'nao_diz' ? '' : (q.valor || '');
  proximaTela();
}

/* ---- tela 7: trecho antes/depois (só transbordo) */
function telaTrecho(box, t) {
  const opts = S.schema.telas.find((x) => x.id === 'modal').opcoes;
  box.innerHTML = `<h2 class="pergunta">${esc(t.titulo)}</h2>` +
    t.campos.map((c) => `<h3>${esc(c.rotulo)}</h3>
      <div class="chips c2" data-campo="${esc(c.campo)}">${opts.map((o) =>
        `<button class="chip" data-v="${esc(o.v)}" aria-pressed="${S.r[c.campo] === o.v}">
          <span class="ic">${o.i}</span><span>${esc(o.r)}</span></button>`).join('')}</div>`).join('') +
    `<div class="acoes">${btVoltar}<button class="b-primario" id="t-seguir">Seguir ›</button></div>`;
  box.querySelectorAll('[data-campo]').forEach((g) => g.querySelectorAll('[data-v]').forEach((b) => {
    b.onclick = () => {
      S.r[g.dataset.campo] = b.dataset.v;
      g.querySelectorAll('[data-v]').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
    };
  }));
  el('t-seguir').onclick = proximaTela;
  ligarVoltar();
}

/* ---- tela 8: perfil (todos com nao_informado; V12) */
function telaPerfil(box, t) {
  const pinta = () => {
    const menor = S.r.faixa_etaria === 'ate_17';
    box.innerHTML = `<h2 class="pergunta">${esc(t.titulo)}</h2>` +
      t.grupos.map((g) => `<h3>${esc(g.rotulo)}</h3>
        <div class="chips c${g.colunas}" data-campo="${esc(g.campo)}">${g.opcoes.map((o) =>
          `<button class="chip" data-v="${esc(o.v)}" aria-pressed="${S.r[g.campo] === o.v}">${esc(o.r)}</button>`).join('')}</div>`).join('') +
      (menor ? `<div class="aviso erro" style="margin-top:.8rem">
          <label style="display:flex;gap:.6rem;align-items:center;margin:0">
          <input type="checkbox" id="cons" style="width:28px;height:28px;min-height:28px"
            ${S.r.consentimento_responsavel ? 'checked' : ''}>
          <span>${esc(t.condicional_consentimento.rotulo)}</span></label></div>` : '') +
      `<div class="acoes">${btVoltar}<button class="b-primario" id="pf-seguir">Seguir ›</button></div>`;
    box.querySelectorAll('[data-campo]').forEach((g) => g.querySelectorAll('[data-v]').forEach((b) => {
      b.onclick = () => {
        S.r[g.dataset.campo] = b.dataset.v;
        const completos = t.grupos.every((x) => S.r[x.campo] !== undefined && S.r[x.campo] !== '');
        if (g.dataset.campo === 'faixa_etaria') { pinta(); if (completos && !menorAgora()) proximaTela(); return; }
        g.querySelectorAll('[data-v]').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
        if (completos && !menorAgora()) proximaTela();   // avanço automático quando os 3 fecham
      };
    }));
    const cb = el('cons'); if (cb) cb.onchange = () => (S.r.consentimento_responsavel = cb.checked);
    el('pf-seguir').onclick = proximaTela;
    ligarVoltar();
  };
  const menorAgora = () => S.r.faixa_etaria === 'ate_17';
  pinta();
}

/* ---- tela 9: resumo + salvar */
function telaResumo(box, t) {
  const r = S.r, rot = (campo, v) => {
    for (const tl of S.schema.telas) {
      const ops = tl.opcoes || (tl.grupos || []).flatMap((g) => (g.campo === campo ? g.opcoes : []));
      if ((tl.campo === campo || (tl.grupos || []).some((g) => g.campo === campo)) && ops)
        return (ops.find((o) => String(o.v) === String(v)) || {}).r || v;
    }
    return v;
  };
  /* Categoria + complemento em texto, quando houver: Outro (“levar filho na creche”).
     É o que deixa o pesquisador CONFERIR o que digitou antes de finalizar. */
  const motivo = (campo) => {
    const base = esc(rot(campo, r[campo]));
    const tx = String(r[campo + '_outro'] || '').trim();
    return tx ? `${base} <small>(“${esc(tx)}”)</small>` : base;
  };
  /* Distância O→D — SÓ EXIBIÇÃO: não valida, não bloqueia, não muda toque nenhum.
     Existe porque texto esconde exatamente o que quebrou no D1: dois rótulos "Centro" e
     "Centro" tanto podem ser a mesma coordenada quanto 3 km. A distância é o número que
     não mente, e aparece na tela onde o pesquisador confere antes de finalizar.
     Vermelho abaixo de 100 m: mais largo que o corte do V08 (25 m) de propósito — aqui
     custa só um olhar, então marca também o caso limítrofe que não merece um modal. */
  const dOD = (() => {
    const n = (v) => { if (v === '' || v === null || v === undefined) return null; const x = Number(v); return isFinite(x) ? x : null; };
    const a = n(r.origem_lat), b = n(r.origem_lon), c = n(r.destino_lat), d = n(r.destino_lon);
    return (a !== null && b !== null && c !== null && d !== null) ? haversine(a, b, c, d) : null;
  })();
  box.innerHTML = `
    <h2 class="pergunta">${esc(t.titulo)}</h2>
    <div class="resumo"><dl>
      <dt>Ponto</dt><dd>${esc(r.ponto_id)} · ${esc(r.ponto_nome)}</dd>
      <dt>Origem</dt><dd>${esc(resumoLocal('origem'))} <small>(nível ${esc(r.origem_nivel || '—')})</small></dd>
      <dt>Destino</dt><dd>${esc(resumoLocal('destino'))} <small>(nível ${esc(r.destino_nivel || '—')})</small></dd>
      ${dOD !== null ? `<dt>O→D</dt><dd${dOD < 100 ? ' class="perto"' : ''}>${dOD} m${
        dOD < 100 ? ' <small>— confira se o destino é mesmo aqui</small>' : ''}</dd>` : ''}
      <dt>Modo</dt><dd>${esc(rot('modal', r.modal))}${r.acesso_onibus
        ? ` <small>(acesso: ${esc(rot('acesso_onibus', r.acesso_onibus))})</small>` : ''}</dd>
      <dt>Motivo</dt><dd>${motivo('origem_motivo')} → ${motivo('destino_motivo')}</dd>
      <dt>Tempo</dt><dd>${esc(r.tempo_viagem_min ?? '—')} min</dd>
      <dt>Perfil</dt><dd>${esc(rot('sexo', r.sexo))} · ${esc(rot('faixa_etaria', r.faixa_etaria))} · ${esc(rot('escolaridade', r.escolaridade))}${
        r.entrevistado_tipo === 'comerciante_local' ? ' · <b>comerciante local</b>' : ''}</dd>
    </dl></div>
    <details class="opc"><summary>＋ Opcional (frequência, acompanhantes, observação)</summary>
      <div id="opc-c"></div>
      <label for="obs">Observação do pesquisador</label>
      <textarea id="obs" rows="2" placeholder="só se algo fugiu do padrão">${esc(r.obs_pesquisador || '')}</textarea>
    </details>
    <p>${badgeGps()} ${r.distancia_ao_ponto_m !== '' && r.distancia_ao_ponto_m != null
      ? `<span class="dica">· ${r.distancia_ao_ponto_m} m do ponto</span>` : ''}</p>
    <div id="v-msg"></div>
    <div class="rodape-acao">
      <div class="acoes">${btVoltar}
        <button class="b-primario" id="salvar" style="min-height:64px">✓ Finalizar e salvar</button></div>
    </div>`;

  const oc = el('opc-c');
  (t.opcionais || []).forEach((g) => {
    const d = document.createElement('div');
    d.innerHTML = `<h3>${esc(g.rotulo)}</h3><div class="chips c${g.colunas}" data-campo="${esc(g.campo)}">${
      g.opcoes.map((o) => `<button class="chip" data-v="${esc(o.v)}" aria-pressed="${String(S.r[g.campo]) === String(o.v)}">${esc(o.r)}</button>`).join('')}</div>`;
    oc.appendChild(d);
    d.querySelectorAll('[data-v]').forEach((b) => b.onclick = () => {
      S.r[g.campo] = g.numerico ? Number(b.dataset.v) : b.dataset.v;
      d.querySelectorAll('[data-v]').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
    });
  });
  el('obs').oninput = (e) => (S.r.obs_pesquisador = e.target.value);
  el('salvar').onclick = salvar;
  ligarVoltar();
}

/* ================================================================ salvar */
async function salvar() {
  const r = S.r;
  r.ts_fim = new Date().toISOString();
  r.duracao_s = Math.round((new Date(r.ts_fim) - new Date(r.ts_inicio)) / 1000);
  const d = new Date(r.ts_inicio);
  r.horario_abordagem = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  r.periodo = periodoDe(d, S.schema.periodo_cortes);
  if (fixVelho() && S.fix) carimbarGps();
  r.recusa_localizacao = (Number(r.origem_nivel) >= 5 && Number(r.destino_nivel) >= 5);

  const uuidsLocais = (await todos('respostas')).map((x) => x.uuid);
  const v = validar(r, {
    pontosAtivos: S.pontos.filter((p) => p.ativo !== false).map((p) => p.ponto_id),
    agora: Date.now(), uuidsLocais,
  });

  if (ehDescarteSilencioso(v)) { toast('Registro duplicado — descartado (V11).'); return depois(); }
  if (v.bloqueios.length) {
    el('v-msg').innerHTML = `<div class="aviso erro"><b>Não dá para salvar ainda:</b><ul>${
      v.bloqueios.map((b) => `<li>${esc(b.id)} — ${esc(b.msg)}</li>`).join('')}</ul></div>`;
    el('v-msg').scrollIntoView({ block: 'center' });
    navigator.vibrate?.([25, 60, 25]);        // padrão "parou": distinto do toque único do salvo
    return;
  }
  /* Dupla confirmação da tela final (pedido do coordenador, 24/08): salvar é irreversível
   * do ponto de vista do entrevistador, então sempre passa por aqui. Quando há avisos de
   * validação, eles entram NO MESMO modal — dois modais seguidos ninguém lê. */
  const q = await modal({
    titulo: 'Finalizar esta pesquisa?',
    corpo: (v.confirmacoes.length
      ? `<div class="aviso"><b>Confira antes:</b><ul>${v.confirmacoes.map((c) =>
          `<li>${esc(c.msg)}</li>`).join('')}</ul></div>` : '') +
      '<p>A entrevista vai para a fila e é enviada sozinha.</p>',
    acoes: [{ id: 'nao', rotulo: 'Voltar e conferir' },
            { id: 'sim', rotulo: '✓ Finalizar e salvar', estilo: 'b-primario' }],
  });
  if (q !== 'sim') return;
  /* flags de QC que o próprio aparelho já sabe carimbar */
  const flags = [];
  if (r.distancia_ao_ponto_m !== '' && r.distancia_ao_ponto_m > 300) flags.push('Q04_dist>300m');
  if (classificarAccuracy(r.abordagem_accuracy_m).cor !== 'verde') flags.push('Q10_accuracy');
  if (S.limiteRing && r.abordagem_lat && foraDoMunicipio(r.abordagem_lat, r.abordagem_lon, S.limiteRing))
    flags.push('Q03_fora_do_municipio');
  r.qc_flags = flags.join('|');

  await put('respostas', {
    uuid: r.uuid, status: 'pendente', dia: hoje(), criado_em: r.ts_fim, payload: { ...r },
  });
  /* Confirmação TÁTIL do gravado (0.9.17). Ataca o sintoma real do D1 — "deu OK e voltou pra
     origem", a incerteza sobre se registrou. Aditivo puro: sem permissão, degrada em silêncio
     no iPhone. Fica só aqui e no bloqueio: vibrar a cada avanço de tela, com 9 telas e 150
     entrevistas, viraria ruído tátil e deixaria de significar coisa alguma. */
  navigator.vibrate?.(12);
  toast('Salvo. Já está na fila.', 'ok');
  depois();
}

async function depois() {
  S.r = null; await wakeOff(); await pintarCabecalho();
  sincronizar(false);
  novaEntrevista();          // volta direto para a tela 1 no mesmo ponto
}

/* ================================================================ recusa (1 toque) */
function vRecusa() {
  const c = S.schema.recusa;
  main().innerHTML = `
    <h2 class="pergunta">${esc(c.titulo)}</h2>
    <div class="chips c${c.colunas}" id="r-mot"></div>
    <details class="opc" style="margin-top:.9rem"><summary>＋ Sexo / faixa aproximados (opcional)</summary>
      <div id="r-ap"></div></details>
    <div class="acoes">${btVoltar}</div>`;
  const g = el('r-mot');
  c.opcoes.forEach((o) => {
    const b = document.createElement('button'); b.className = 'chip'; b.textContent = o.r;
    b.onclick = () => gravarRecusa(o.v);
    g.appendChild(b);
  });
  const ap = el('r-ap'); S._recusaAprox = {};
  (c.aprox || []).forEach((a) => {
    const d = document.createElement('div');
    d.innerHTML = `<h3>${esc(a.rotulo)}</h3><div class="chips c4" data-c="${esc(a.campo)}">${
      a.opcoes.map((o) => `<button class="chip" data-v="${esc(o.v)}">${esc(o.r)}</button>`).join('')}</div>`;
    ap.appendChild(d);
    d.querySelectorAll('[data-v]').forEach((b) => b.onclick = () => {
      S._recusaAprox[a.campo] = b.dataset.v;
      d.querySelectorAll('[data-v]').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
    });
  });
  el('bt-voltar').onclick = () => { S.r = null; irPara('ponto'); };
}

async function gravarRecusa(motivo) {
  const u = novoUuid();
  await put('recusas', {
    uuid: u, status: 'pendente', dia: hoje(), criado_em: new Date().toISOString(),
    payload: {
      uuid: u, ts: new Date().toISOString(), pesquisador_id: S.sessao.pesquisador_id,
      ponto_id: S.ponto.ponto_id, motivo, app_version: APP_VERSION,
      sexo_aprox: S._recusaAprox?.sexo_aprox || '', faixa_aprox: S._recusaAprox?.faixa_aprox || '',
    },
  });
  toast('Recusa registrada.');
  await pintarCabecalho(); sincronizar(false);
  S.r = null; novaEntrevista();        // <2 s de volta à tela inicial
}

/* ================================================================ MODO GESTOR (só G01)
 * Ferramenta de realocação em campo, não BI: o gestor precisa saber, no sol e em 3 s,
 * quem está atrasado, quem sumiu e qual ponto está furado. Tolerante a offline: mostra
 * o último quadro salvo com a idade dele em cima, nunca uma tela vazia. */
async function carregarGestao(manual = false) {
  if (!S.gestao) S.gestao = (await metaGet('cache_gestao')) || null;
  if (!API_URL || !S.sessao?.token) return S.gestao;
  try {
    const u = `${API_URL}?action=gestao&pesquisador_id=${encodeURIComponent(S.sessao.pesquisador_id)}` +
              `&token=${encodeURIComponent(S.sessao.token)}`;
    const r = await fetch(u, { cache: 'no-store' });
    const j = JSON.parse(await r.text());
    if (!j.ok) throw new Error(j.erro || 'recusado pelo servidor');
    S.gestao = { dados: j, em: Date.now() };
    await metaSet('cache_gestao', S.gestao);
    if (manual) toast('Quadro atualizado.', 'ok');
  } catch (e) {
    if (manual) toast(S.gestao ? 'Sem sinal — mostrando o último quadro.' : 'Sem sinal e sem quadro salvo.', 'erro');
  }
  return S.gestao;
}

const idadeMin = (ms) => Math.max(0, Math.round((Date.now() - ms) / 60000));

/**
 * Puxa o quadro do time sem depender de ter algo na fila.
 * Os aparelhos entram em campo JÁ LOGADOS (o login é uma vez só, no treinamento), então
 * sem isto o "aqui X/C" ficaria em "só meu" a manhã inteira, até a primeira sincronização.
 * Reusa o login_simples: mesma chamada de sempre, e ainda serve de heartbeat.
 */
async function atualizarQuadro() {
  if (!navigator.onLine || !API_URL || !S.sessao) return;
  if (S.feitoPontos && Date.now() - S.feitoPontos.em < FEITO_VALIDADE_MS) return;
  try {
    const r = await fetch(API_URL, {
      method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify({ action: 'login_simples', pesquisador_id: S.sessao.pesquisador_id,
                             app_version: APP_VERSION, device_id: S.sessao.device_id }),
    });
    const j = JSON.parse(await r.text());
    if (j.ok && j.feito_pontos) { await guardarFeitoPontos(j.feito_pontos); await pintarCabecalho(); }
  } catch { /* offline: o cabeçalho segue com o que sabe, dizendo "só meu" */ }
}

/** Clipboard com plano B: se o navegador recusar, o texto fica na tela para copiar à mão. */
async function copiar(txt) {
  try {
    await navigator.clipboard.writeText(txt);
    toast('Resumo copiado — cole no WhatsApp.', 'ok');
    return true;
  } catch {
    const ta = document.createElement('textarea');
    ta.value = txt; ta.style.position = 'fixed'; ta.style.top = '-1000px';
    document.body.appendChild(ta); ta.focus(); ta.select();
    let ok = false;
    try { ok = document.execCommand('copy'); } catch {}
    ta.remove();
    toast(ok ? 'Resumo copiado — cole no WhatsApp.' : 'Copie o texto da caixa abaixo à mão.', ok ? 'ok' : 'erro');
    return ok;
  }
}

/** O reporte dos 3 pulsos diários em 1 toque. */
function resumoWhatsApp(g) {
  const t = g.totais, ag = new Date();
  const hh = `${String(ag.getHours()).padStart(2, '0')}h${String(ag.getMinutes()).padStart(2, '0')}`;
  const pct = t.meta ? Math.round((t.total / t.meta) * 100) : 0;
  const equipe = [...g.equipe]
    .sort((a, b) => a.pesq_id.localeCompare(b.pesq_id))
    .map((p) => `${p.pesq_id} ${p.hoje}/${p.meta_dia || '—'}`).join(' · ');
  const ab = t.abaixo_do_piso || [];
  return `📊 ${hh} — ${t.total}/${t.meta} (${pct}%) · urb ${t.urbano}/${t.meta_urbano} · ` +
    `rur ${t.rural}/${t.meta_rural} | ${equipe} | pontos ok ${t.pontos_ok} · ` +
    `abaixo do piso ${t.pontos_abaixo_do_piso}${ab.length ? ` (${ab.join(', ')})` : ''}`;
}

async function vGestao() {
  /* trava do cliente, além da do servidor: entrevistador não entra aqui nem por engano */
  if (!ehGestor()) { toast('Vista exclusiva do coordenador.', 'erro'); return irPara('ponto'); }
  main().innerHTML = '<h2 class="pergunta">Equipe e pontos</h2><p class="dica">Carregando o quadro…</p>';
  const g = await carregarGestao(false);
  if (!g) {
    main().innerHTML = `<h2 class="pergunta">Equipe e pontos</h2>
      <div class="aviso erro">Sem sinal e sem quadro salvo ainda. Toque em recarregar quando pegar rede.</div>
      <button class="b-grande" id="g-rec" style="text-align:center">↻ Recarregar</button>
      <div class="acoes">${btVoltar}</div>`;
    el('g-rec').onclick = async () => { await carregarGestao(true); vGestao(); };
    el('bt-voltar').onclick = () => irPara(S.r ? 'entrevista' : 'ponto');
    return;
  }
  pintarGestao(g);
}

function pintarGestao(g) {
  const d = g.dados, idade = idadeMin(g.em);
  const aba = S.gestaoAba || 'equipe';
  main().innerHTML = `
    <h2 class="pergunta">Equipe e pontos</h2>
    <p class="dica">${idade === 0 ? 'agora mesmo' : `atualizado há ${idade} min`} ·
      ${esc(d.totais.total)}/${esc(d.totais.meta)} no total · hoje ${esc(d.totais.hoje)}</p>
    <div class="abas" id="g-abas">
      <button data-t="equipe" aria-selected="${aba === 'equipe'}">Equipe</button>
      <button data-t="pontos" aria-selected="${aba === 'pontos'}">Pontos (${d.pontos.length})</button>
    </div>
    <div id="g-corpo"></div>
    <div class="acoes" style="margin-top:.8rem">${btVoltar}
      <button class="b-primario" id="g-rec">↻ Recarregar</button></div>`;
  main().querySelectorAll('#g-abas button').forEach((b) => b.onclick = () => {
    S.gestaoAba = b.dataset.t; pintarGestao(g);
  });
  el('g-rec').onclick = async () => { const n = await carregarGestao(true); pintarGestao(n || g); };
  el('bt-voltar').onclick = () => irPara(S.r ? 'entrevista' : 'ponto');
  (aba === 'equipe' ? corpoEquipe : corpoPontos)(el('g-corpo'), d);
}

function corpoEquipe(box, d) {
  /* mais atrasado primeiro: quem está mais longe da própria meta do dia */
  const eq = [...d.equipe].sort((a, b) => {
    const pa = a.meta_dia ? a.hoje / a.meta_dia : 1, pb = b.meta_dia ? b.hoje / b.meta_dia : 1;
    return pa - pb;
  });
  box.innerHTML = eq.map((p) => {
    const sm = p.sync_min;
    const cls = sm === null || sm > SYNC_ALERTA_MIN ? 'vermelho' : sm > SYNC_ATENCAO_MIN ? 'amarelo' : 'verde';
    const txt = sm === null ? 'sem contato — ligar'
      : sm > SYNC_ALERTA_MIN ? `sem contato há ${sm} min — ligar`
      : `sync há ${sm} min`;
    return `<div class="cartao">
      <div class="cartao-t"><b>${esc(p.pesq_id)}</b> <span class="dica">${esc(p.nome)}</span>
        <span class="m${p.meta_dia && p.hoje >= p.meta_dia ? ' ok' : ''}">hoje ${esc(p.hoje)}/${esc(p.meta_dia || '—')}</span></div>
      <div class="cartao-s">
        <span class="gps ${cls}">${esc(txt)}</span>
        <span class="dica">fila ${esc(p.fila)}</span>
        <span class="dica">${p.ultimo_ponto ? 'último ponto ' + esc(p.ultimo_ponto) : 'sem entrevista hoje'}</span>
      </div></div>`;
  }).join('') + `
    <button class="b-grande" id="g-copiar" style="text-align:center;margin-top:.6rem">📋 Copiar resumo</button>
    <textarea id="g-txt" rows="3" readonly hidden></textarea>`;
  el('g-copiar').onclick = async () => {
    const txt = resumoWhatsApp(d);
    const ok = await copiar(txt);
    const ta = el('g-txt');
    ta.value = txt; ta.hidden = ok;              // só aparece se o clipboard recusou
    if (!ok) { ta.focus(); ta.select(); }
  };
}

function corpoPontos(box, d) {
  const ordem = S.gestaoOrdem || 'atraso';
  const lista = [...d.pontos];
  if (ordem === 'perto' && S.fix) {
    const porId = {};
    ordenarPontosPorDistancia(S.pontos, S.fix).forEach((p) => (porId[p.ponto_id] = p.dist_m));
    lista.sort((a, b) => (porId[a.ponto_id] ?? 9e9) - (porId[b.ponto_id] ?? 9e9));
  } else {
    lista.sort((a, b) => (a.cota ? a.feito / a.cota : 1) - (b.cota ? b.feito / b.cota : 1));
  }
  const cls = (s, p) => s === 'abaixo_do_piso' ? 'abaixo'
    : p.cota && p.feito >= p.cota * 1.3 ? 'cheio' : s === 'ok' ? 'ok' : 'parcial';
  box.innerHTML = `
    <div class="abas" id="g-ord">
      <button data-o="atraso" aria-selected="${ordem === 'atraso'}">Mais atrasado</button>
      <button data-o="perto" aria-selected="${ordem === 'perto'}">Mais perto</button>
    </div>
    ${ordem === 'perto' && !S.fix ? '<div class="aviso">Sem fix de GPS: ordem por atraso.</div>' : ''}
    <ul class="lista">${lista.map((p) => `<li><div class="item">
      <span class="n"><b>${esc(p.ponto_id)} · ${esc(p.nome)}</b>
        <small>${esc(p.tipo)} · piso ${esc(p.piso)}</small></span>
      <span class="m ${cls(p.status, p)}">${esc(p.feito)}/${esc(p.cota)}</span>
    </div></li>`).join('')}</ul>`;
  box.querySelectorAll('#g-ord button').forEach((b) => b.onclick = () => {
    S.gestaoOrdem = b.dataset.o; corpoPontos(box, d);
  });
}

/* ================================================================ fila / ajustes */
async function vFila() {
  const pend = await itensPendentes();
  const [a, b] = await Promise.all([todos('respostas'), todos('recusas')]);
  const sinc = [...a, ...b].filter((i) => i.status === 'sincronizado').length;
  const ultErro = await metaGet('ultimo_erro');
  main().innerHTML = `
    <h2 class="pergunta">Fila e aparelho</h2>
    <div class="resumo"><dl>
      <dt>Pesquisador</dt><dd>${esc(S.sessao.pesquisador_id)} — ${esc(S.sessao.nome)}</dd>
      <dt>Aparelho</dt><dd>${esc(S.sessao.device_id)}</dd>
      <dt>Token até</dt><dd>${esc(S.sessao.validade || TOKEN_VALIDADE)}</dd>
      <dt>Hoje</dt><dd>${S.contDia} entrevista(s)</dd>
      <dt>Pendentes</dt><dd><b>${pend.length}</b></dd>
      <dt>Enviadas</dt><dd>${sinc}</dd>
      <dt>Rede</dt><dd>${navigator.onLine ? 'online' : 'OFFLINE'}</dd>
      <dt>Versão</dt><dd>app ${esc(APP_VERSION)} · schema ${esc(S.schema.schema_version)}</dd>
      ${ultErro ? `<dt>Último erro</dt><dd style="color:var(--erro);overflow-wrap:anywhere"><small>${
        esc(ultErro.em.slice(11, 16))} · app ${esc(ultErro.app)} · ${esc(ultErro.msg)}</small></dd>` : ''}
    </dl></div>
    <button class="b-primario b-grande" id="f-sync" style="text-align:center">Sincronizar agora (${pend.length})</button>
    <button class="b-grande" id="f-ponto" style="text-align:center">Trocar de ponto</button>
    ${blocoInstalar()}
    <button class="b-grande" id="f-sair" style="text-align:center">🚪 Sair / trocar usuário</button>
    <h3>Encerramento (§6.3.8)</h3>
    <p class="dica">Só com a fila em <b>0</b> e o coordenador presente.</p>
    <button class="b-grande b-recusa" id="f-limpar" style="text-align:center">Limpar dados locais</button>
    <div class="acoes">${btVoltar}</div>`;
  el('f-sync').onclick = () => sincronizar(true);
  el('f-ponto').onclick = () => irPara('ponto');
  ligarInstalar();
  /* Sair / trocar usuário: a fila é sagrada — sair NUNCA descarta pendência.
   * Não reatribui nada: pesquisador_id é carimbado no momento do salvar. */
  el('f-sair').onclick = async () => {
    if (pend.length) {
      const q = await modal({
        titulo: 'Ainda há entrevistas na fila',
        corpo: `<p>Envie as <b>${pend.length}</b> pendentes antes de trocar de usuário.
                Nada será descartado.</p>`,
        acoes: [{ id: 'nao', rotulo: 'Voltar' }, { id: 'sync', rotulo: 'Sincronizar agora', estilo: 'b-primario' }],
      });
      if (q === 'sync') sincronizar(true);
      return;
    }
    const q = await modal({
      titulo: 'Sair e trocar de usuário?',
      corpo: '<p>Você volta para a tela de escolha de nome. As entrevistas já enviadas ' +
             'continuam no servidor — nada se perde.</p>',
      acoes: [{ id: 'nao', rotulo: 'Cancelar' }, { id: 'sim', rotulo: 'Sair', estilo: 'b-recusa' }],
    });
    if (q !== 'sim') return;
    await metaSet('sessao', null);
    await metaSet('cache_gestao', null);          // quadro do gestor não fica no aparelho do próximo
    S.sessao = null; S.ponto = null; S.r = null; S.gestao = null; S.cotaAvisada = {};
    el('hdr').hidden = true;
    irPara('login');
  };
  el('f-limpar').onclick = async () => {
    if (pend.length) { toast(`Ainda há ${pend.length} na fila. Sincronize primeiro.`, 'erro'); return; }
    const q = await modal({
      titulo: 'Limpar dados locais?',
      corpo: '<p>Apaga entrevistas, recusas e o login deste aparelho. Só faça com o coordenador presente.</p>',
      acoes: [{ id: 'nao', rotulo: 'Cancelar' }, { id: 'sim', rotulo: 'Apagar tudo', estilo: 'b-recusa' }],
    });
    if (q !== 'sim') return;
    await tx('respostas', 'readwrite', (s) => s.clear());
    await tx('recusas', 'readwrite', (s) => s.clear());
    await tx('meta', 'readwrite', (s) => s.clear());
    location.reload();
  };
  el('bt-voltar').onclick = () => irPara(S.ponto ? 'ponto' : 'ponto');
}

/* ================================================================ boot */
async function boot() {
  if ('serviceWorker' in navigator) {
    // versão viaja na query: APP_VERSION (config.js) é a fonte única do nome do cache
    try { await navigator.serviceWorker.register(`./sw.js?v=${APP_VERSION}`, { scope: './' }); }
    catch (e) { console.warn(e); }
  }
  try { await carregarDados(); }
  catch (e) {
    main().innerHTML = `<div class="aviso erro"><b>Não foi possível carregar os dados.</b><br>${esc(e.message)}
      <br><br>Abra o aplicativo uma vez com internet antes de ir a campo.</div>`;
    return;
  }
  S.equipe = (await metaGet('cache_equipe')) || EQUIPE_PADRAO;
  S.sessao = await metaGet('sessao');
  S.feitoPontos = (await metaGet('feito_pontos')) || null;
  iniciarGps(); ligarSync();
  el('h-menu').onclick = () => irPara('fila');
  const btEq = el('h-equipe'); if (btEq) btEq.onclick = () => irPara('gestao');
  await pintarCabecalho();

  if (!S.sessao) return irPara('login');
  if (S.sessao.validade && hoje() > S.sessao.validade)
    toast('Token vencido — fale com o coordenador.', 'erro');
  atualizarQuadro();                                  // começa o dia com o quadro do time
  irPara('ponto');
}

/* Lista de nomes para o seletor de login. NÃO é segredo: o token é que autentica.
   Fica embutida para que a tela de login funcione mesmo se o servidor estiver fora do ar. */
const EQUIPE_PADRAO = [
  { pesq_id: 'G01', nome: 'Luiz Gustavo' },
  { pesq_id: 'P01', nome: 'José Henrique Seixas' },
  { pesq_id: 'P02', nome: 'Guilherme Santos Batista' },
  { pesq_id: 'P03', nome: 'Danielle Firmiano Costa dos Santos' },
  { pesq_id: 'P04', nome: 'André Egídio' },
];

/* Caixa-preta de erros (24/08 21h20, caso Danielle): qualquer erro não tratado vira
 * (a) toast vermelho na hora e (b) registro em meta 'ultimo_erro', exibido na tela
 * Fila e aparelho. Sem isto, erro em campo = "não tá funcionando" sem pista. */
function registrarErro(origem, msg) {
  const e = { em: new Date().toISOString(), origem, msg: String(msg).slice(0, 300), app: APP_VERSION };
  metaSet('ultimo_erro', e).catch(() => {});
  try { toast('⚠️ Erro no app: ' + e.msg.slice(0, 90), 'erro'); } catch {}
}
window.addEventListener('error', (ev) =>
  registrarErro('erro', (ev.message || '?') + ' @ ' + (ev.filename || '').split('/').pop() + ':' + (ev.lineno || '?')));
window.addEventListener('unhandledrejection', (ev) =>
  registrarErro('promise', ev.reason && (ev.reason.stack || ev.reason.message || ev.reason) || '?'));

boot();
