/* queue.js — lógica pura da fila offline, sync e validações.
 * Sem DOM, sem IndexedDB, sem fetch global: tudo injetado.
 * É este arquivo que o test/fila_test.mjs exercita em Node.
 *
 * REGRA DA CASA (§7.2 passo 9): ok:true SEM o uuid na lista acked = FALHOU.
 * Nada sai da fila sem ACK nominal do próprio uuid.
 */

export const LOTE_MAX = 25;

/* ---------------------------------------------------------------- uuid */
export function novoUuid(rnd) {
  const r = rnd || ((n) => {
    const a = new Uint8Array(n);
    (globalThis.crypto || {}).getRandomValues
      ? globalThis.crypto.getRandomValues(a)
      : a.forEach((_, i) => (a[i] = Math.floor(Math.random() * 256)));
    return a;
  });
  const b = r(16);
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/* ---------------------------------------------------------------- geo */
export function haversine(lat1, lon1, lat2, lon2) {
  if ([lat1, lon1, lat2, lon2].some((v) => typeof v !== 'number' || !isFinite(v))) return null;
  const R = 6371008.8, rad = Math.PI / 180;
  const dLat = (lat2 - lat1) * rad, dLon = (lon2 - lon1) * rad;
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(dLon / 2) ** 2;
  return Math.round(2 * R * Math.asin(Math.sqrt(a)));
}

/** Lista de pontos ordenada pela distância ao fix atual (o mais próximo no topo).
 *  Sem fix: devolve a ordem original com dist=null (nunca esconde ponto). */
export function ordenarPontosPorDistancia(pontos, fix) {
  const temFix = fix && typeof fix.lat === 'number' && typeof fix.lon === 'number';
  return pontos
    .map((p) => ({ ...p, dist_m: temFix ? haversine(fix.lat, fix.lon, p.lat, p.lon) : null }))
    .sort((a, b) => {
      if (a.dist_m === null && b.dist_m === null) return 0;
      if (a.dist_m === null) return 1;
      if (b.dist_m === null) return -1;
      return a.dist_m - b.dist_m;
    });
}

/* ---------------------------------------------------------------- accuracy (V06 / Q10) */
export function classificarAccuracy(m) {
  if (m === null || m === undefined || !isFinite(m)) return { cor: 'cinza', acao: 'justifica' };
  if (m <= 50) return { cor: 'verde', acao: 'aceita' };
  if (m <= 100) return { cor: 'amarelo', acao: 'aceita' };
  if (m <= 500) return { cor: 'laranja', acao: 'confirma' };
  return { cor: 'vermelho', acao: 'justifica' };
}

/* ---------------------------------------------------------------- período */
export function periodoDe(date, cortes) {
  const hm = `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
  for (const c of cortes) if (hm >= c.de && hm < c.ate) return c.id;
  return cortes[cortes.length - 1].id;
}

/* ---------------------------------------------------------------- normalização p/ autocomplete */
export function normalizar(s) {
  return (s || '')
    .toString()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const STOP = new Set(['rua', 'r', 'avenida', 'av', 'travessa', 'tv', 'estrada', 'rodovia',
  'praca', 'alameda', 'linha', 'da', 'de', 'do', 'dos', 'das', 'e']);

/** Busca por prefixo em qualquer palavra significativa do nome. Top N. */
export function buscarVias(indice, termo, top = 8) {
  const q = normalizar(termo);
  if (q.length < 2) return [];
  const toks = q.split(' ').filter(Boolean);
  const out = [];
  for (const via of indice) {
    const n = via._n || (via._n = normalizar(via.n || via.nome));
    const palavras = n.split(' ');
    let pontuacao = 0, todos = true;
    for (const t of toks) {
      if (n.startsWith(t)) { pontuacao += 3; continue; }
      const hit = palavras.some((p) => p.startsWith(t) && !STOP.has(p));
      const hit2 = palavras.some((p) => p.startsWith(t));
      if (hit) pontuacao += 2;
      else if (hit2) pontuacao += 1;
      else { todos = false; break; }
    }
    if (todos) out.push({ via, pontuacao, tam: n.length });
  }
  out.sort((a, b) => b.pontuacao - a.pontuacao || a.tam - b.tam);
  return out.slice(0, top).map((o) => o.via);
}

/* ---------------------------------------------------------------- validações V01–V12 */
const RE_NUMERO = /^(\d{1,5}|s\/n|S\/N)$/;
const NI = 'nao_informado';

/**
 * @returns {{bloqueios:Array, confirmacoes:Array, ok:boolean}}
 */
export function validar(r, ctx = {}) {
  const bloqueios = [], confirmacoes = [];
  const B = (id, msg) => bloqueios.push({ id, msg });
  const C = (id, msg) => confirmacoes.push({ id, msg });

  if (r.consentimento_verbal !== true) B('V01', 'Sem consentimento verbal não se salva a entrevista.');

  const ativos = ctx.pontosAtivos || [];
  if (!r.ponto_id || (ativos.length && !ativos.includes(r.ponto_id)))
    B('V02', 'Ponto inválido ou inativo.');

  const faltando = [];
  for (const c of ['modal', 'origem_motivo', 'destino_motivo', 'tempo_viagem_min'])
    if (r[c] === undefined || r[c] === null || r[c] === '') faltando.push(c);
  /* v1.0: o acesso ao ônibus só existe como pergunta quando o modo É ônibus */
  if (r.modal === 'onibus' && (r.acesso_onibus === undefined || r.acesso_onibus === null || r.acesso_onibus === ''))
    faltando.push('acesso_onibus');
  for (const c of ['sexo', 'faixa_etaria', 'escolaridade'])
    if (r[c] === undefined || r[c] === null || r[c] === '') faltando.push(c); // nao_informado É valor válido
  if (faltando.length) B('V03', 'Faltam respostas obrigatórias: ' + faltando.join(', '));

  const t = Number(r.tempo_viagem_min);
  if (r.tempo_viagem_min !== undefined && r.tempo_viagem_min !== null && r.tempo_viagem_min !== '' &&
      (!isFinite(t) || t < 1 || t > 600))
    B('V04', 'Tempo de viagem deve ficar entre 1 e 600 minutos.');

  const on = Number(r.origem_nivel), dn = Number(r.destino_nivel);
  if (!(on >= 1 && on <= 6)) B('V05', 'Origem sem nenhum dado aproveitável.');
  if (!(dn >= 1 && dn <= 6)) B('V05', 'Destino sem nenhum dado aproveitável.');

  const acc = classificarAccuracy(r.abordagem_accuracy_m);
  if (acc.acao === 'confirma') C('V06', `GPS com ${Math.round(r.abordagem_accuracy_m)} m de erro. Confirma o ponto?`);
  if (acc.acao === 'justifica' && !r.obs_pesquisador)
    B('V06', 'GPS acima de 500 m (ou ausente): escreva uma justificativa em observações.');

  if (r.abordagem_gps_ts && ctx.agora) {
    const idade = (ctx.agora - new Date(r.abordagem_gps_ts).getTime()) / 1000;
    if (idade > 120) C('V07', 'O fix de GPS está com mais de 120 s. Pedindo novo antes de salvar.');
  }

  const chave = (p) => normalizar(`${r[p + '_logradouro'] || ''} ${r[p + '_numero'] || ''} ${r[p + '_bairro'] || ''}`);
  if (chave('origem') && chave('origem') === chave('destino'))
    C('V08', 'Origem e destino são o mesmo endereço. Tem certeza?');

  if (isFinite(Number(r.duracao_s)) && Number(r.duracao_s) < 45)
    C('V09', `Entrevista de ${r.duracao_s} s. Confirma que foi real?`);

  for (const c of ['origem_numero', 'destino_numero']) {
    const v = r[c];
    if (v !== undefined && v !== null && String(v).trim() !== '' && !RE_NUMERO.test(String(v).trim()))
      B('V10', `Campo ${c}: use 1 a 5 dígitos ou s/n.`);
  }

  if ((ctx.uuidsLocais || []).includes(r.uuid)) B('V11', '__descarta_silencioso__');

  if (r.faixa_etaria === 'ate_17' && r.consentimento_responsavel !== true)
    B('V12', 'Menor de 18: exige consentimento do responsável presente (V12).');

  return { bloqueios, confirmacoes, ok: bloqueios.length === 0 };
}

export const ehDescarteSilencioso = (v) =>
  v.bloqueios.length === 1 && v.bloqueios[0].id === 'V11';

/* ---------------------------------------------------------------- lote */
export function montarLote(pendentes, max = LOTE_MAX) {
  return pendentes.filter((i) => i.status === 'pendente').slice(0, max);
}

/**
 * Decide o que sai da fila a partir da resposta do servidor.
 * NUNCA confia em ok:true sozinho — só o uuid presente em `acked` é dado como gravado.
 * @returns {{sincronizados:string[], mantidos:string[], erro:string|null, schema_version:string|null}}
 */
export function aplicarAck(enviados, resposta) {
  const ids = enviados.map((i) => i.uuid);
  if (!resposta || typeof resposta !== 'object')
    return { sincronizados: [], mantidos: ids, erro: 'resposta vazia ou não-JSON', schema_version: null, feito_pontos: null };
  if (resposta.ok !== true)
    return { sincronizados: [], mantidos: ids, erro: resposta.erro || 'ok != true', schema_version: resposta.schema_version || null, feito_pontos: null };

  const acked = Array.isArray(resposta.acked) ? resposta.acked : [];
  const set = new Set(acked);
  const sincronizados = ids.filter((u) => set.has(u));
  const mantidos = ids.filter((u) => !set.has(u));
  return {
    sincronizados,
    mantidos,
    erro: mantidos.length ? `ok:true mas ${mantidos.length} uuid(s) sem ACK — mantidos na fila` : null,
    schema_version: resposta.schema_version || null,
    feito_pontos: (resposta.feito_pontos && typeof resposta.feito_pontos === 'object')
      ? resposta.feito_pontos : null,
  };
}

/**
 * Envia um lote. `fetchImpl` é injetado (browser: window.fetch; teste: mock).
 * Qualquer falha de rede/HTTP/JSON devolve tudo para a fila.
 */
export async function enviarLote({ fetchImpl, url, token, pesquisador_id, device_id,
                                   itens, fila_pendente = 0, app_version = '', timeoutMs = 30000 }) {
  const ids = itens.map((i) => i.uuid);
  if (!itens.length) return { sincronizados: [], mantidos: [], erro: null, schema_version: null, feito_pontos: null };
  if (!url) return { sincronizados: [], mantidos: ids, erro: 'API_URL não configurada', schema_version: null, feito_pontos: null };

  const corpo = {
    action: 'respostas',
    token, pesquisador_id, device_id, app_version,
    fila_pendente,
    respostas: itens.filter((i) => i.tipo !== 'recusa').map((i) => i.payload),
    recusas: itens.filter((i) => i.tipo === 'recusa').map((i) => i.payload),
    enviado_em: new Date().toISOString(),
  };

  let resp;
  try {
    const ctl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const tm = ctl ? setTimeout(() => ctl.abort(), timeoutMs) : null;
    // text/plain evita preflight CORS no Apps Script
    const r = await fetchImpl(url, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify(corpo),
      signal: ctl ? ctl.signal : undefined,
      redirect: 'follow',
    });
    if (tm) clearTimeout(tm);
    if (!r.ok) return { sincronizados: [], mantidos: ids, erro: `HTTP ${r.status}`, schema_version: null, feito_pontos: null };
    const txt = await r.text();
    try { resp = JSON.parse(txt); }
    catch { return { sincronizados: [], mantidos: ids, erro: 'resposta não é JSON (login do Google?)', schema_version: null, feito_pontos: null }; }
  } catch (e) {
    return { sincronizados: [], mantidos: ids, erro: `rede: ${e && e.message ? e.message : e}`, schema_version: null, feito_pontos: null };
  }
  return aplicarAck(itens, resp);
}

/* ---------------------------------------------------------------- área certa (v0.9.3)
 * "Estou no lugar certo?" é pergunta de UM toque, não de mapa. O aparelho já sabe a
 * distância ao ponto SELECIONADO e qual ponto está mais perto — basta dizer em voz alta.
 * NUNCA bloqueia: a pessoa pode estar legitimamente a 400 m (ponto grande, obra, chuva). */
export const RAIO_PONTO_M = 300;

export function avaliarPosicao(fix, selecionado, pontos = [], raio = RAIO_PONTO_M) {
  const vazio = { dist_m: null, longe: false, sugestao: null };
  if (!fix || !selecionado || typeof fix.lat !== 'number') return vazio;
  const dist_m = haversine(fix.lat, fix.lon, selecionado.lat, selecionado.lon);
  if (dist_m === null) return vazio;
  const longe = dist_m > raio;
  let sugestao = null;
  if (longe) {
    const perto = ordenarPontosPorDistancia(pontos.filter((p) => p.ativo !== false), fix)[0];
    /* só sugere se o vizinho for REALMENTE melhor, senão vira ruído a cada fix */
    if (perto && perto.ponto_id !== selecionado.ponto_id && perto.dist_m !== null && perto.dist_m < dist_m)
      sugestao = perto;
  }
  return { dist_m, longe, sugestao };
}

/* ---------------------------------------------------------------- cota do ponto (G3)
 * 100% = pode estender até +30% se o fluxo estiver bom. 130% = está roubando amostra de
 * outro ponto, migre. Também nunca bloqueia: dado coletado não se joga fora. */
export const COTA_EXTENSAO = 1.3;

export function avaliarCota(feito, cota) {
  const c = Number(cota) || 0, f = Number(feito) || 0;
  if (!c) return { estado: 'sem_cota', pct: 0 };
  const pct = f / c;
  if (pct >= COTA_EXTENSAO) return { estado: 'excedida', pct };
  if (pct >= 1) return { estado: 'completa', pct };
  return { estado: 'andamento', pct };
}

/* ---------------------------------------------------------------- fila_espera */
export function filaEsperaMin(ts_fim, agora) {
  const a = new Date(ts_fim).getTime();
  if (!isFinite(a)) return '';
  return Math.max(0, Math.round((agora - a) / 60000));
}

/* ---------------------------------------------------------------- limite municipal
 * Q03 pergunta "esta coordenada é de outro município?", não "o traçado do OSM concorda
 * com o KMZ até o metro". PU24 (Esc. Benjamin Constant) fica 34 m FORA do polígono do
 * OSM — dentro do erro de digitalização do próprio limite. Sem tolerância, Q03 marcaria
 * todas as entrevistas daquele ponto e viraria ruído.
 * Regra: só é "fora" quem está fora E a mais de `tol` metros da divisa. */
export const TOLERANCIA_LIMITE_M = 250;

export function foraDoMunicipio(lat, lon, ring, tol = TOLERANCIA_LIMITE_M) {
  const d = dentroDoPoligono(lat, lon, ring);
  if (d === null || d === true) return false;
  let min = Infinity;
  for (let i = 0; i < ring.length; i++) {
    const m = haversine(lat, lon, ring[i][1], ring[i][0]);
    if (m !== null && m < min) { min = m; if (min <= tol) return false; }
  }
  return min > tol;
}

export function dentroDoPoligono(lat, lon, ring) {
  if (!ring || ring.length < 4) return null;
  let dentro = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0], yi = ring[i][1], xj = ring[j][0], yj = ring[j][1];
    if ((yi > lat) !== (yj > lat) && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) dentro = !dentro;
  }
  return dentro;
}
