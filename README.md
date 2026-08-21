# Pesquisa Origem-Destino — Rio Branco do Sul (PR)

PWA de coleta de campo, **offline-first**, do levantamento origem-destino do
**Plano de Mobilidade Urbana de Rio Branco do Sul**.

Executada pela **Toposcan**. A prefeitura está ciente do levantamento.

## O que é

Aplicativo usado pelos entrevistadores em campo, em pé, na rua. Funciona sem
sinal de celular: grava em IndexedDB e sincroniza quando a rede volta.

- **42 pontos de pesquisa** — 29 urbanos + 13 rurais, meta de 350 entrevistas
- **Offline real** — Service Worker + fila local; um registro pode ficar horas
  no aparelho até haver sinal
- **Sem geocodificação no celular** — autocomplete das vias a partir de extract
  local do OpenStreetMap
- **Mapa vetorial local** — nenhuma tile é baixada de servidor externo

## Privacidade

O formulário **não tem campo de nome, CPF, telefone, e-mail ou placa** — é
impossível por desenho. Não se fotografa entrevistado. O endereço de origem é
dado de localização de terceiro e vai **apenas** para a FUNPAR; qualquer
material público usa exclusivamente **agregados por zona**.

O painel público (`/painel/`) devolve **somente agregados por ponto** — nenhuma
linha individual, endereço ou coordenada de residência.

## Estrutura

```
index.html  app.js  queue.js  style.css  sw.js  config.js
data/    pontos.json · schema.json · alias.json · localidades.json
         pois.json · ruas_rbs.geojson
vendor/  leaflet.js · leaflet.css   (servidos localmente, sem CDN)
painel/  painel read-only de agregados
```

`queue.js` é um módulo puro (fila, ACK, validações V01–V12) com bateria de
testes em Node fora deste repositório.

O questionário é **schema-driven**: as telas saem de `data/schema.json`; o
renderer não conhece as perguntas.

## Sem segredos

Este repositório é público por exigência do GitHub Pages. **Nenhuma credencial
vive aqui.** A autenticação é por token individual do pesquisador, emitido pelo
servidor e digitado uma única vez no aparelho.

## Créditos de dados

Vias, limite municipal e hidrografia: **© OpenStreetMap contributors**,
licenciados sob [ODbL](https://www.openstreetmap.org/copyright).
