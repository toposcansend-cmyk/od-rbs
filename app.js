/* app.js — PWA de coleta da pesquisa OD de Rio Branco do Sul.
 * Renderer SCHEMA-DRIVEN: as telas 1..9 saem de data/schema.json, não daqui.
 * Toda a lógica de fila/ACK/validação vive em queue.js (puro, testado em Node).
 */
import { APP_VERSION, API_URL, SYNC_INTERVALO_MS, LOTE_MAX, TOKEN_VALIDADE } from './config.js';
import {
  novoUuid, haversine, ordenarPontosPorDistancia, classificarAccuracy, periodoDe,
  normalizar, buscarVias, validar, ehDescarteSilencioso, montarLote, enviarLote,
  filaEsperaMin, dentroDoPoligono, foraDoMunicipio,
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
  enviando: false, wakeLock: null, mapa: null, marcador: null,
};
const el = (id) => document.getElementById(id);
const main = () => el('main');
const hoje = () => new Date().toISOString().slice(0, 10);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/* ================================================================ UI utils */
let toastT;
function toast(msg, tipo = '') {
  const t = el('toast'); t.textContent = msg; t.className = tipo; t.hidden = false;
  clearTimeout(toastT); toastT = setTimeout(() => (t.hidden = true), tipo === 'erro' ? 5200 : 2600);
}
function modal({ titulo, corpo, acoes }) {
  return new Promise((res) => {
    el('modal-t').textContent = titulo;
    el('modal-c').innerHTML = corpo || '';
    const a = el('modal-a'); a.innerHTML = '';
    acoes.forEach((ac) => {
      const b = document.createElement('button');
      b.textContent = ac.rotulo; b.className = ac.estilo || 'b-fantasma';
      b.onclick = () => { el('modal').hidden = true; res(ac.id); };
      a.appendChild(b);
    });
    el('modal').hidden = false;
  });
}

/* ================================================================ GPS (§7.3) */
function iniciarGps() {
  if (!navigator.geolocation) { S.fix = null; return; }
  navigator.geolocation.watchPosition(
    (p) => {
      S.fix = {
        lat: p.coords.latitude, lon: p.coords.longitude,
        acc: p.coords.accuracy, ts: new Date(p.timestamp).toISOString(),
        fonte: p.coords.accuracy <= 100 ? 'gps' : 'rede',
      };
      pintarCabecalho();
    },
    () => { /* mantém o último fix; nunca zera o que já foi bom */ },
    { enableHighAccuracy: true, maximumAge: 15000, timeout: 60000 }
  );
}
const fixVelho = () => !S.fix || (Date.now() - new Date(S.fix.ts).getTime()) / 1000 > 120;
function badgeGps() {
  if (!S.fix) return '<span class="gps cinza">GPS sem fix</span>';
  const c = classificarAccuracy(S.fix.acc);
  const v = fixVelho() ? ' · fix &gt;120s' : '';
  return `<span class="gps ${c.cor}">📍 ±${Math.round(S.fix.acc)} m${v}</span>`;
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
  window.addEventListener('online', () => sincronizar(false));    // gatilho 1: evento online
  el('h-sync').onclick = () => sincronizar(true);                 // gatilho 4: botão manual
  navigator.serviceWorker?.ready.then((reg) => {                  // gatilho 3: Background Sync (não-iOS)
    reg.sync?.register('od-sync').catch(() => {});
  }).catch(() => {});
  navigator.serviceWorker?.addEventListener('message', (e) => {   // o SW acorda o app após Background Sync
    if (e.data?.tipo === 'sincronize') sincronizar(false);
  });
}

/* ================================================================ cabeçalho (tela 0) */
async function pintarCabecalho() {
  if (!S.sessao) { el('hdr').hidden = true; return; }
  el('hdr').hidden = false;
  S.fila = await contarFila(); S.contDia = await contarHoje();
  el('h-pesq').textContent = S.sessao.pesquisador_id;
  el('h-ponto').textContent = S.ponto ? `${S.ponto.ponto_id} ${S.ponto.nome}` : '— selecione o ponto —';
  el('h-cont').textContent = `${S.contDia}/${S.sessao.meta_dia || '—'} hoje`;
  el('h-fila').textContent = S.fila;
  el('h-sync').classList.toggle('pendente', S.fila > 0);
  el('h-sync').title = S.fila ? `Sincronizar agora (${S.fila} na fila)` : 'Tudo sincronizado';
}

/* ================================================================ router */
function irPara(vista) { S.vista = vista; render(); window.scrollTo(0, 0); }

function render() {
  switch (S.vista) {
    case 'login': return vLogin();
    case 'ponto': return vPonto();
    case 'entrevista': return vTela();
    case 'recusa': return vRecusa();
    case 'fila': return vFila();
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
    <p class="dica">Toque no seu nome e depois em <b>Começar</b>. É só na primeira vez —
    depois o aplicativo funciona até sem internet.</p>
    <div id="l-lista" class="lista-nomes"></div>
    <div class="acoes"><button id="l-ok" class="b-primario" disabled>Começar</button></div>
    <div id="l-msg"></div>
    <p class="dica" style="margin-top:1.2rem">Versão ${esc(APP_VERSION)} · schema ${esc(S.schema?.schema_version || '—')}</p>`;

  const lista = el('l-lista'); let escolhido = '';
  (S.equipe || []).forEach((p) => {
    const b = document.createElement('button'); b.type = 'button';
    b.innerHTML = `${esc(p.nome)}<span class="sub">${esc(p.pesq_id)}</span>`;
    b.onclick = () => {
      escolhido = p.pesq_id;
      [...lista.children].forEach((x) => x.classList.remove('sel'));
      b.classList.add('sel'); el('l-ok').disabled = false;
    };
    lista.appendChild(b);
  });

  el('l-ok').onclick = async () => {
    const msg = el('l-msg');
    if (!escolhido) { msg.innerHTML = '<div class="aviso erro">Toque no seu nome primeiro.</div>'; return; }
    if (!API_URL) { msg.innerHTML = '<div class="aviso erro">API_URL não configurada neste build (ver DEPLOY.md).</div>'; return; }
    el('l-ok').disabled = true;
    msg.innerHTML = '<div class="aviso">Entrando…</div>';
    try {
      const r = await fetch(API_URL, {
        method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' },
        body: JSON.stringify({ action: 'login_simples', pesquisador_id: escolhido,
                               app_version: APP_VERSION, device_id: await deviceId() }),
      });
      const j = JSON.parse(await r.text());
      if (!j.ok) { el('l-ok').disabled = false; msg.innerHTML = `<div class="aviso erro">${esc(j.erro || 'Não deu para entrar — chame o coordenador.')}</div>`; return; }
      S.sessao = {
        pesquisador_id: j.pesquisador_id, nome: j.nome, token: j.token,
        validade: j.token_validade, meta_dia: j.meta_dia, device_id: await deviceId(),
        entrou_em: new Date().toISOString(),
      };
      await metaSet('sessao', S.sessao);           // <- nunca mais pede, mesmo em modo avião
      toast(`Bem-vindo(a), ${j.nome}.`, 'ok');
      await pintarCabecalho(); irPara('ponto');
    } catch (e) {
      el('l-ok').disabled = false;
      msg.innerHTML = `<div class="aviso erro">Sem internet agora. A primeira entrada precisa de sinal — depois nunca mais.<br><small>${esc(e.message)}</small></div>`;
    }
  };
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
    ${!S.fix ? '<div class="aviso">Ainda sem fix de GPS. A lista está na ordem do cadastro — confira o ponto pelo nome.</div>' : ''}
    <ul class="lista" id="p-lista"></ul>`;
  const ul = el('p-lista');
  lista.forEach((p) => {
    const li = document.createElement('li');
    const b = document.createElement('button'); b.className = 'item';
    const d = p.dist_m === null ? '—' : p.dist_m < 1000 ? `${p.dist_m} m` : `${(p.dist_m / 1000).toFixed(1)} km`;
    b.innerHTML = `<span class="d">${esc(d)}</span>
      <span class="n"><b>${esc(p.ponto_id)} · ${esc(p.nome)}</b>
      <small>${esc(p.bairro)} · ${p.tipo === 'rural' ? 'rural ' + esc(p.rota) : 'urbano · Tier ' + esc(p.tier)}</small></span>
      <span class="m">meta ${p.meta_entrevistas}</span>`;
    b.onclick = () => { S.ponto = p; pintarCabecalho(); novaEntrevista(); };
    li.appendChild(b); ul.appendChild(li);
  });
}

/* ================================================================ ENTREVISTA */
function telasAtivas() {
  return S.schema.telas.filter((t) => {
    if (!t.condicional) return true;
    if (t.condicional.includes('transbordo')) return S.ponto?.transbordo === true;
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
  S.tela = 0; irPara('entrevista');
}

function proximaTela() {
  const ts = telasAtivas();
  if (S.tela >= ts.length - 1) return;
  S.tela++; render(); window.scrollTo(0, 0);
}
function telaAnterior() {
  if (S.tela === 0) { S.r = null; wakeOff(); irPara('ponto'); return; }
  S.tela--; render(); window.scrollTo(0, 0);
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
    <p>${badgeGps()}</p>
    <div class="acoes">
      <button class="b-primario" id="a-ok" style="min-height:64px">Aceitou</button>
      <button class="b-recusa" id="a-no" style="min-height:64px">Recusa</button>
    </div>
    <div style="margin-top:1rem">${btVoltar}</div>`;
  el('a-ok').onclick = () => {
    S.r.consentimento_verbal = true;
    S.r.ts_inicio = new Date().toISOString();          // <- definição travada no dicionário
    carimbarGps();
    wakeOn();
    proximaTela();
  };
  el('a-no').onclick = () => irPara('recusa');
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
function telaCascata(box, t) {
  const p = t.prefixo, casc = S.schema.cascata;
  const jaTem = S.r[p + '_nivel'];
  box.innerHTML = `
    <h2 class="pergunta">${esc(t.titulo)}</h2>
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
function gravarLocal(p, dados) {
  Object.entries(dados).forEach(([k, v]) => (S.r[p + '_' + k] = v));
  if (!S.r[p + '_municipio']) S.r[p + '_municipio'] = 'Rio Branco do Sul';
  S.r[p + '_zona'] = zonaDe(p);
  render();
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
                     bairro: S.ponto.bairro, municipio: 'Rio Branco do Sul' });
    toast('Coordenada atual registrada (nível 1).', 'ok');
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
          const res = buscarVias(S.vias, q.value, casc.autocomplete.top);
          if (!res.length && normalizar(q.value).length >= 2)
            sug.innerHTML = '<li class="dica">Nada encontrado. Tente a aba Bairro/localidade ou "Ponto de referência".</li>';
          res.forEach((v) => sug.appendChild(itemSug(v.n, 'via de Rio Branco do Sul', () => pedirNumero(p, v))));
        } else {
          const todas = [...(S.localidades.bairros_urbanos || []), ...(S.localidades.localidades_rurais || [])];
          buscarVias(todas.map((x) => ({ ...x, n: x.nome })), q.value, 8)
            .forEach((v) => sug.appendChild(itemSug(v.nome, v.tipo, () => {
              gravarLocal(p, { nivel: casc.so_bairro_nivel, metodo: 'texto_livre',
                precisao_m: casc.so_bairro_precisao_m, bairro: v.nome, logradouro: '', numero: '',
                lat: v.lat, lon: v.lon, municipio: 'Rio Branco do Sul' });
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
          bairro: x.bairro, lat: x.lat, lon: x.lon, municipio: 'Rio Branco do Sul' }))));
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
      gravarLocal(p, { nivel: bairro ? 5 : 6, metodo: 'texto_livre', precisao_m: bairro ? 800 : 5000,
        municipio: mun, bairro, logradouro: '', numero: '', lat: '', lon: '' });
      S.r[p + '_zona'] = 'ZE01';
    };
    return;
  }
}

function itemSug(titulo, sub, onClick) {
  const li = document.createElement('li');
  const b = document.createElement('button');
  b.innerHTML = `${esc(titulo)}<small>${esc(sub || '')}</small>`;
  b.onclick = onClick; li.appendChild(b); return li;
}

function pedirNumero(p, via) {
  const casc = S.schema.cascata;
  const area = el('c-area');
  area.innerHTML = `
    <div class="aviso ok"><b>${esc(via.n)}</b></div>
    <label for="num">Número (deixe vazio se a pessoa não quiser dar — fica nível 3)</label>
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
    gravarLocal(p, {
      nivel: comN ? casc.com_numero_nivel : 3,
      metodo: 'autocomplete_via',
      precisao_m: comN ? casc.com_numero_precisao_m : 150,
      logradouro: via.n, numero: n, bairro: el('bai').value.trim(),
      lat: via.lat, lon: via.lon, municipio: 'Rio Branco do Sul',
    });
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
      municipio: fora ? '' : 'Rio Branco do Sul', bairro: '' });
    toast(fora ? 'Pino fora do limite municipal — confira.' : 'Pino registrado (nível 1).', fora ? 'erro' : 'ok');
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
    b.onclick = () => { S.r[t.campo] = o.v; proximaTela(); };   // avanço automático
    c.appendChild(b);
  });
  if (t.permite_outro) el('outro-ok').onclick = () => {
    const v = Number(el('outro').value);
    if (!isFinite(v) || v < t.min || v > t.max) { toast(`Use ${t.min} a ${t.max} (V04).`, 'erro'); return; }
    S.r[t.campo] = v; proximaTela();
  };
  ligarVoltar();
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
  box.innerHTML = `
    <h2 class="pergunta">${esc(t.titulo)}</h2>
    <div class="resumo"><dl>
      <dt>Ponto</dt><dd>${esc(r.ponto_id)} · ${esc(r.ponto_nome)}</dd>
      <dt>Origem</dt><dd>${esc(resumoLocal('origem'))} <small>(nível ${esc(r.origem_nivel || '—')})</small></dd>
      <dt>Destino</dt><dd>${esc(resumoLocal('destino'))} <small>(nível ${esc(r.destino_nivel || '—')})</small></dd>
      <dt>Modo</dt><dd>${esc(rot('modal', r.modal))}</dd>
      <dt>Motivo</dt><dd>${esc(rot('motivo', r.motivo))}</dd>
      <dt>Tempo</dt><dd>${esc(r.tempo_viagem_min ?? '—')} min</dd>
      <dt>Perfil</dt><dd>${esc(rot('sexo', r.sexo))} · ${esc(rot('faixa_etaria', r.faixa_etaria))} · ${esc(rot('escolaridade', r.escolaridade))}</dd>
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
        <button class="b-primario" id="salvar" style="min-height:64px">Salvar e próxima</button></div>
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
    return;
  }
  if (v.confirmacoes.length) {
    const q = await modal({
      titulo: 'Confirme antes de salvar',
      corpo: `<ul>${v.confirmacoes.map((c) => `<li><b>${esc(c.id)}</b> — ${esc(c.msg)}</li>`).join('')}</ul>`,
      acoes: [{ id: 'nao', rotulo: 'Voltar e corrigir' }, { id: 'sim', rotulo: 'Confirmo, salvar', estilo: 'b-primario' }],
    });
    if (q !== 'sim') return;
  }
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

/* ================================================================ fila / ajustes */
async function vFila() {
  const pend = await itensPendentes();
  const [a, b] = await Promise.all([todos('respostas'), todos('recusas')]);
  const sinc = [...a, ...b].filter((i) => i.status === 'sincronizado').length;
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
    </dl></div>
    <button class="b-primario b-grande" id="f-sync" style="text-align:center">Sincronizar agora (${pend.length})</button>
    <button class="b-grande" id="f-ponto" style="text-align:center">Trocar de ponto</button>
    <h3>Encerramento (§6.3.8)</h3>
    <p class="dica">Só com a fila em <b>0</b> e o coordenador presente.</p>
    <button class="b-grande b-recusa" id="f-limpar" style="text-align:center">Limpar dados locais</button>
    <div class="acoes">${btVoltar}</div>`;
  el('f-sync').onclick = () => sincronizar(true);
  el('f-ponto').onclick = () => irPara('ponto');
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
  iniciarGps(); ligarSync();
  el('h-menu').onclick = () => irPara('fila');
  await pintarCabecalho();

  if (!S.sessao) return irPara('login');
  if (S.sessao.validade && hoje() > S.sessao.validade)
    toast('Token vencido — fale com o coordenador.', 'erro');
  irPara('ponto');
}

/* Lista de nomes para o seletor de login. NÃO é segredo: o token é que autentica.
   Fica embutida para que a tela de login funcione mesmo se o servidor estiver fora do ar. */
const EQUIPE_PADRAO = [
  { pesq_id: 'G01', nome: 'Gestor de campo' },
  { pesq_id: 'P01', nome: 'Entrevistador 1' },
  { pesq_id: 'P02', nome: 'Entrevistador 2' },
  { pesq_id: 'P03', nome: 'Entrevistador 3' },
  { pesq_id: 'P04', nome: 'Entrevistador 4' },
];

boot();
