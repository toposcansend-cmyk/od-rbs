/* config.js — único arquivo que muda entre ambientes.
 * NÃO contém segredo: o repositório é público (§7.3 trava 1).
 * O token é por pesquisador, digitado uma vez na segunda 25/08 e guardado no aparelho.
 */
export const APP_VERSION = '0.9.9';

/* URL /exec do Web App do Apps Script — JÁ IMPLANTADA em 21/08.
 * Responde 403 até o dono autorizar os escopos uma vez no editor (ver DEPLOY.md).
 * A URL não muda com isso: autorizar não recria o deployment.
 * Regra da casa: alterações futuras usam `clasp deploy -i <DEPLOY_ID>` no MESMO
 * deployment, então esta linha nunca mais precisa ser tocada. */
export const API_URL = 'https://script.google.com/macros/s/AKfycbz8jtDJSicgd2UoRHCyPBQ4Qe0PJZjzbC1yXAAcWukjNQw3iYSxZzPorgYVMeTLL947Gg/exec';

/* Janela de campo (só para rótulos e para o contador do dia).
 * Calendário real corrigido 24/08: campo ter 25/08 a qui 27/08; reforço seg 31/08 + ter 01/09. */
export const DIAS_CAMPO = ['2026-08-25', '2026-08-26', '2026-08-27', '2026-08-31', '2026-09-01'];
export const TOKEN_VALIDADE = '2026-09-06';

/* Sync */
export const SYNC_INTERVALO_MS = 30000;
export const LOTE_MAX = 25;
