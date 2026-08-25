#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
gen_vias_cnefe.py — enriquece app/data/ruas_rbs.geojson com os logradouros do
CNEFE 2022 (IBGE) de Rio Branco do Sul/PR (código 4122206).

Motivo (25/08, campo VIVO): o Overpass devolveu só 220 vias nomeadas; o OSM não
cobre a malha residencial nem a zona rural. O CNEFE tem TODOS os logradouros do
município, com coordenada por endereço (NV_GEO_COORD=1 em 96,5% dos 17.705
registros).

Fonte (público, sem chave):
  https://ftp.ibge.gov.br/Cadastro_Nacional_de_Enderecos_para_Fins_Estatisticos/
    Censo_Demografico_2022/Arquivos_CNEFE/CSV/Municipio/41_PR/
    4122206_RIO_BRANCO_DO_SUL.zip

REGRAS DA CASA
  1. A ESTRUTURA do geojson não muda: vias_index / limite / features /
     limite_ring / limite_fechado seguem iguais. Só `vias_index` cresce.
  2. Registro de via = {n, lat, lon, f}. `f` é 'osm' ou 'cnefe'. O app não lê
     `f` — é rastreabilidade. Nada além disso entra: o arquivo viaja no bundle.
  3. Empate de nome normalizado (o MESMO `normalizar()` do queue.js) => fica a
     do OSM, que tem geometria de verdade. O CNEFE só ENTRA onde falta.
  4. Estrada rural tem 35 km. Uma mediana só para a via inteira seria mentira:
     quando os aglomerados de localidade ficam a mais de 3 km um do outro, a via
     é quebrada em até 3 entradas rotuladas "Nome (Localidade)". Assim o
     entrevistador escolhe o trecho e a coordenada do nível 3 vale alguma coisa.

Uso:
    python tools/gen_vias_cnefe.py [--cnefe <dir com o CSV>] [--dry]
"""

import argparse
import collections
import csv
import json
import math
import os
import re
import statistics
import sys
import unicodedata
import zipfile
from urllib.request import urlopen

COD_IBGE = "4122206"
URL_CNEFE = (
    "https://ftp.ibge.gov.br/Cadastro_Nacional_de_Enderecos_para_Fins_Estatisticos/"
    "Censo_Demografico_2022/Arquivos_CNEFE/CSV/Municipio/41_PR/"
    "4122206_RIO_BRANCO_DO_SUL.zip"
)

RAIZ = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
GEOJSON = os.path.join(RAIZ, "app", "data", "ruas_rbs.geojson")
LOCALIDADES = os.path.join(RAIZ, "app", "data", "localidades.json")

# --- parâmetros de quebra por localidade ------------------------------------
QUEBRA_M = 3000.0     # aglomerados a mais de 3 km viram entradas separadas
MAX_TRECHOS = 3       # nunca mais que 3 entradas para o mesmo nome
MIN_PTS_TRECHO = 3    # trecho com menos que isso é absorvido pelo vizinho

# lixo do cadastro: são marcadores de "não tem nome", não nomes
LIXO = {"sem denominacao", "sem denominação", "nao denominada", "s n"}

# abreviações do cadastro que ninguém digita por extenso errado
ABREV = {"BCO": "Branco"}

MINUSCULAS = {"de", "da", "do", "das", "dos", "e", "a", "o", "ao", "aos",
              "em", "na", "no", "nas", "nos", "com", "para", "sem"}
CAIXA_ALTA = {"PR", "BR", "KM", "SP", "SC", "RS", "MG", "II", "III", "IV", "V",
              "VI", "BCO"}


# ---------------------------------------------------------------- normalizar
def normalizar(s):
    """Gêmeo EXATO do normalizar() de app/queue.js. Se um dos dois mudar, a
    deduplicação contra o OSM passa a mentir — mudar sempre os dois."""
    s = unicodedata.normalize("NFD", s or "")
    s = "".join(c for c in s if unicodedata.category(c) != "Mn").lower()
    s = re.sub(r"[^a-z0-9 ]", " ", s)
    return re.sub(r"\s+", " ", s).strip()


def titulo(s):
    """CNEFE vem em CAIXA ALTA sem acento. Vira 'Rua Padre Ribeiro'."""
    out = []
    for i, p in enumerate(s.split()):
        if p in ABREV:
            out.append(ABREV[p])
        elif p in CAIXA_ALTA:
            out.append(p)
        elif p.isdigit():
            out.append(p)
        elif i > 0 and p.lower() in MINUSCULAS:
            out.append(p.lower())
        else:
            out.append(p[:1].upper() + p[1:].lower())
    return " ".join(out)


def metros(a, b):
    """Distância aproximada entre (lat, lon). Escala local, plano tangente."""
    dy = (a[0] - b[0]) * 111320.0
    dx = (a[1] - b[1]) * 111320.0 * math.cos(math.radians(a[0]))
    return math.hypot(dy, dx)


def mediana(pts):
    return (round(statistics.median(p[0] for p in pts), 6),
            round(statistics.median(p[1] for p in pts), 6))


def distancia_edicao(a, b, teto=2):
    """Levenshtein com corte. Só para casar erro de digitação do cadastro."""
    if abs(len(a) - len(b)) > teto:
        return teto + 1
    ant = list(range(len(b) + 1))
    for i, ca in enumerate(a, 1):
        cur = [i]
        for j, cb in enumerate(b, 1):
            cur.append(min(ant[j] + 1, cur[j - 1] + 1, ant[j - 1] + (ca != cb)))
        if min(cur) > teto:
            return teto + 1
        ant = cur
    return ant[-1]


# ---------------------------------------------------------------- CNEFE
def baixar_cnefe(destino):
    os.makedirs(destino, exist_ok=True)
    zp = os.path.join(destino, COD_IBGE + ".zip")
    if not os.path.exists(zp):
        sys.stderr.write("baixando CNEFE...\n")
        with urlopen(URL_CNEFE, timeout=300) as r, open(zp, "wb") as f:
            f.write(r.read())
    with zipfile.ZipFile(zp) as z:
        nome = [n for n in z.namelist() if n.lower().endswith(".csv")][0]
        z.extract(nome, destino)
    return os.path.join(destino, nome)


def ler_cnefe(caminho):
    """-> {nome_normalizado: {'rotulo': str, 'pts': [(lat, lon, localidade)]}}"""
    grupos = collections.defaultdict(lambda: {"rotulo": "", "pts": []})
    with open(caminho, encoding="latin-1", newline="") as f:
        for x in csv.DictReader(f, delimiter=";"):
            base = (x["NOM_SEGLOGR"] or "").strip()
            if not base or normalizar(base) in LIXO:
                continue
            tipo = (x["NOM_TIPO_SEGLOGR"] or "").strip()
            tit = (x["NOM_TITULO_SEGLOGR"] or "").strip()
            cru = " ".join(p for p in (tipo, tit, base) if p)
            # "ESTRADA ESTRADA DO JACARE" — tipo repetido no próprio nome
            cru = re.sub(r"^(\w+)\s+\1\b", r"\1", cru)
            if normalizar(cru) in LIXO:
                continue
            try:
                lat = float(x["LATITUDE"])
                lon = float(x["LONGITUDE"])
            except (TypeError, ValueError):
                continue
            if not (-26 < lat < -24 and -50 < lon < -48):
                continue
            g = grupos[normalizar(cru)]
            g["rotulo"] = titulo(cru)
            g["pts"].append((lat, lon, (x["DSC_LOCALIDADE"] or "").strip()))
    return grupos


def fundir_variantes(grupos, osm_keys, log):
    """CNEFE tem erro de digitação: AGRIMENSOR / AGREMESSOR / AGRIMENSSOR,
    MORAES / MORAIS, MANGER / MANGUER, CAPIRUZINO / CAPIRUZINHO.

    Funde a GEOMETRIA (os pontos viram um só aglomerado, mediana melhor) mas
    NÃO apaga grafia nenhuma: quem some da lista some da busca, e a missão aqui
    é justamente achar o que o entrevistado fala. Cada grafia vira uma entrada
    apontando para a MESMA coordenada. A grafia dominante (ou a que casa com o
    OSM) é a que ganha a quebra por localidade; as outras entram uma vez só.

    Guardas: nome longo, sem dígito (RUA 1 x RUA 2 distam 1!) e < 1,5 km.
    """
    chaves = sorted(grupos, key=lambda k: -len(grupos[k]["pts"]))
    dono = {}                       # variante -> chave canônica
    for i, a in enumerate(chaves):
        if a in dono:
            continue
        for b in chaves[i + 1:]:
            if b in dono or len(b) < 12 or len(a) < 12:
                continue
            if any(c.isdigit() for c in a + b):
                continue
            if distancia_edicao(a, b) > 2:
                continue
            ma = mediana([(p[0], p[1]) for p in grupos[a]["pts"]])
            mb = mediana([(p[0], p[1]) for p in grupos[b]["pts"]])
            if metros(ma, mb) > 1500:
                continue
            dono[b] = a
            log.append("  mesma via  %-40s ~ %s" % (grupos[a]["rotulo"],
                                                    grupos[b]["rotulo"]))

    familias = collections.defaultdict(list)
    for k in grupos:
        familias[dono.get(k, k)].append(k)

    saida = {}
    for canon, membros in familias.items():
        pts = [p for k in membros for p in grupos[k]["pts"]]
        # a grafia que o OSM já usa manda; senão, a mais frequente
        principal = next((k for k in membros if k in osm_keys), None) or \
            max(membros, key=lambda k: len(grupos[k]["pts"]))
        saida[principal] = {"rotulo": grupos[principal]["rotulo"],
                            "pts": pts, "alias": []}
        for k in membros:
            if k != principal:
                saida[principal]["alias"].append(grupos[k]["rotulo"])
    return saida


def quebrar_por_localidade(pts, base=""):
    """-> [(rotulo_localidade|None, (lat, lon), n_pontos)]"""
    nb = normalizar(base)
    por_loc = collections.defaultdict(list)
    for lat, lon, loc in pts:
        por_loc[loc or "?"].append((lat, lon))

    ordem = sorted(por_loc.items(), key=lambda kv: -len(kv[1]))
    clusters = []  # [{'centro':(lat,lon), 'locs':[(nome,n)], 'pts':[...]}]
    for loc, ps in ordem:
        m = mediana(ps)
        alvo = None
        for c in clusters:
            if metros(c["centro"], m) <= QUEBRA_M:
                alvo = c
                break
        if alvo is None:
            clusters.append({"centro": m, "locs": [(loc, len(ps))], "pts": list(ps)})
        else:
            alvo["pts"].extend(ps)
            alvo["locs"].append((loc, len(ps)))
            alvo["centro"] = mediana(alvo["pts"])

    if len(clusters) == 1:
        return [(None, mediana(clusters[0]["pts"]), len(clusters[0]["pts"]))]

    clusters.sort(key=lambda c: -len(c["pts"]))
    fica, sobra = clusters[:MAX_TRECHOS], clusters[MAX_TRECHOS:]
    sobra += [c for c in fica[1:] if len(c["pts"]) < MIN_PTS_TRECHO]
    fica = [fica[0]] + [c for c in fica[1:] if len(c["pts"]) >= MIN_PTS_TRECHO]
    for c in sobra:
        alvo = min(fica, key=lambda k: metros(k["centro"], c["centro"]))
        alvo["pts"].extend(c["pts"])
        alvo["locs"].extend(c["locs"])
    if len(fica) == 1:
        return [(None, mediana(fica[0]["pts"]), len(fica[0]["pts"]))]

    saida = []
    for c in fica:
        ordenadas = sorted(c["locs"], key=lambda t: -t[1])
        # "Barra da Santana (Barra da Santana)" não informa nada: prefere a
        # localidade seguinte quando o nome da via já a contém
        loc = next((l for l, _ in ordenadas
                    if l and l != "?" and normalizar(l) not in nb), None)
        if loc is None:
            loc = next((l for l, _ in ordenadas if l and l != "?"), None)
        saida.append((titulo(loc) if loc else None,
                      mediana(c["pts"]), len(c["pts"])))
    # sem rótulo distinguível, dois trechos com o mesmo nome = colisão inútil
    if sum(1 for s in saida if s[0] is None) > 1 or \
       len({s[0] for s in saida}) < len(saida):
        todos = [p for c in fica for p in c["pts"]]
        return [(None, mediana(todos), len(todos))]
    return saida


# ---------------------------------------------------------------- main
def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--cnefe", default=os.path.join(RAIZ, "tools", "_cnefe"))
    ap.add_argument("--dry", action="store_true")
    ap.add_argument("--localidades", action="store_true",
                    help="também completa localidades.json com o DSC_LOCALIDADE do CNEFE")
    a = ap.parse_args()

    csv_path = baixar_cnefe(a.cnefe)
    grupos = ler_cnefe(csv_path)

    with open(GEOJSON, encoding="utf-8") as f:
        geo = json.load(f)

    osm = [{"n": v["n"], "lat": v["lat"], "lon": v["lon"], "f": "osm"}
           for v in geo["vias_index"]]
    vistos = {normalizar(v["n"]) for v in osm}
    antes = len(osm)

    log = []
    grupos = fundir_variantes(grupos, set(vistos), log)

    novas, pulados, quebrados = [], 0, 0
    for chave in sorted(grupos):
        g = grupos[chave]
        if chave in vistos:          # regra 3: o OSM ganha, tem geometria
            pulados += 1
            trechos = []
        else:
            trechos = quebrar_por_localidade(g["pts"], g["rotulo"])
            if len(trechos) > 1:
                quebrados += 1
        # grafias alternativas do cadastro: uma entrada, na coordenada do grupo
        centro = mediana([(p[0], p[1]) for p in g["pts"]])
        candidatos = [("%s (%s)" % (g["rotulo"], loc) if loc else g["rotulo"], c)
                      for loc, c, _n in trechos]
        candidatos += [(alt, centro) for alt in g["alias"]]
        for nome, (lat, lon) in candidatos:
            k = normalizar(nome)
            if k in vistos:
                continue
            vistos.add(k)
            novas.append({"n": nome, "lat": lat, "lon": lon, "f": "cnefe"})

    geo["vias_index"] = sorted(osm + novas, key=lambda v: normalizar(v["n"]))
    geo["attribution"] = ("(c) OpenStreetMap contributors, ODbL; "
                          "logradouros: IBGE CNEFE Censo 2022 (4122206)")

    print("\n".join(log))
    print("-" * 60)
    print("OSM ............... %4d" % antes)
    print("grupos CNEFE ...... %4d  (%d já existiam no OSM)" % (len(grupos), pulados))
    print("nomes quebrados ... %4d  (trecho por localidade)" % quebrados)
    print("vias novas ........ %4d" % len(novas))
    print("TOTAL ............. %4d" % len(geo["vias_index"]))

    if a.dry:
        for v in novas[:25]:
            print("   +", v["n"], v["lat"], v["lon"])
        return

    with open(GEOJSON, "w", encoding="utf-8") as f:
        json.dump(geo, f, ensure_ascii=False, separators=(",", ":"))
    print("gravado %s (%.0f KB)" % (GEOJSON, os.path.getsize(GEOJSON) / 1024))

    if a.localidades:
        atualizar_localidades(grupos, csv_path)


def atualizar_localidades(grupos, csv_path):
    """O CNEFE traz 145 DSC_LOCALIDADE com coordenada; localidades.json tem 34.
    Acrescenta as que faltam — as existentes NUNCA são tocadas (têm acento e
    grafia revisada, e o zonaDe() do app casa por elas)."""
    por_loc = collections.defaultdict(list)
    with open(csv_path, encoding="latin-1", newline="") as f:
        for x in csv.DictReader(f, delimiter=";"):
            loc = (x["DSC_LOCALIDADE"] or "").strip()
            if not loc:
                continue
            try:
                por_loc[loc].append((float(x["LATITUDE"]), float(x["LONGITUDE"])))
            except (TypeError, ValueError):
                pass

    with open(LOCALIDADES, encoding="utf-8") as f:
        loc_json = json.load(f)
    vistos = {normalizar(x["nome"]) for x in loc_json["bairros_urbanos"]}
    vistos |= {normalizar(x["nome"]) for x in loc_json["localidades_rurais"]}

    # o campo DSC_LOCALIDADE aceita texto livre: entra nome de rua, "RURAL",
    # o próprio município e o marcador de vazio. Nada disso é bairro.
    NAO_E_LOCALIDADE = re.compile(
        r"^(estrada|rodovia|avenida|marginal|rua|travessa|linha)\b|"
        r"^(rural|zona rural|rio branco do sul|sem denominacao|"
        r"regiao sem denominacao|centro)$")

    add = 0
    for nome, pts in sorted(por_loc.items()):
        # "BAIRRO NATANEA" -> "Natanea", mas "BAIRRO ALTO" continua inteiro:
        # sozinho, "Alto" não é achável por quem digita "bairro alto"
        limpo = nome.strip()
        corte = re.sub(r"^BAIRRO\s+", "", limpo).strip()
        if corte != limpo and (len(corte) > 6 or " " in corte):
            limpo = corte
        chave = normalizar(limpo)
        if len(pts) < 5 or chave in vistos or NAO_E_LOCALIDADE.match(chave):
            continue
        lat, lon = mediana(pts)
        vistos.add(chave)
        loc_json["localidades_rurais"].append({
            "nome": titulo(limpo), "tipo": "localidade",
            "municipio": "Rio Branco do Sul", "lat": lat, "lon": lon,
        })
        add += 1
    loc_json["localidades_rurais"].sort(key=lambda x: normalizar(x["nome"]))
    with open(LOCALIDADES, "w", encoding="utf-8") as f:
        json.dump(loc_json, f, ensure_ascii=False, indent=1)
    print("localidades.json: +%d (total %d urbanas+rurais)"
          % (add, len(loc_json["bairros_urbanos"]) + len(loc_json["localidades_rurais"])))


if __name__ == "__main__":
    main()
