/* ==========================================================================
   Teses & Dissertações — Educação e Ensino
   Consulta a API pública do Observatório da Pós-Graduação da CAPES
   (Plataforma Sucupira), restrita às áreas de avaliação EDUCAÇÃO e ENSINO.

   A API libera CORS (Access-Control-Allow-Origin: *), por isso o site é
   inteiramente estático: não há backend, chave nem instalação.
   ========================================================================== */

'use strict';

const API = 'https://apigw-proxy.capes.gov.br/observatorio';
const LINK_CAPES = 'https://sucupira.capes.gov.br/observatorio/detalhamento/teses-e-dissertacoes/';

const PDF_API = (() => {
  const host = location.hostname;
  const local = location.protocol === 'file:'
    || host === 'localhost' || host === '127.0.0.1'
    || host === '::1' || host === '[::1]';
  return local ? '' : String(window.CAPES_PDF_API || '').replace(/\/$/, '');
})();

const POR_PAGINA = 15;
const CONCORRENCIA = 6;   // detalhes buscados em paralelo
const MAX_CSV = 300;      // linhas máximas da exportação

const AREA_FALLBACK = {
  'EDUCAÇÃO': 'EDUCAÇÃO'.padEnd(50),
  'ENSINO': 'ENSINO',
};

const TIPO_FALLBACK = { 'TESE': '1', 'DISSERTAÇÃO': '2' };

const $ = (seletor, raiz = document) => raiz.querySelector(seletor);
const $$ = (seletor, raiz = document) => Array.from(raiz.querySelectorAll(seletor));

const fmt = new Intl.NumberFormat('pt-BR');

const estado = {
  q: '',
  escopo: 'titulo,resumo',
  exato: false,
  area: 'ambas',
  de: '',
  ate: '',
  tipo: '',
  ies: '',
  uf: '',
  regiao: '',
  dependencia: '',
  pagina: 1,

  areas: { ...AREA_FALLBACK },
  tipos: { ...TIPO_FALLBACK },
  anos: [],
  baseTotal: 109183,

  total: null,
  itens: [],
  cartoes: new Map(),      // id -> elemento do cartão
  detalhes: new Map(),     // id -> objeto de detalhe
  promessas: new Map(),    // id -> promessa de detalhe
  ctrl: null,
  scan: null,
  pdfApi: false,
  seq: 0,
  ultimoFoco: null,
};

/* --------------------------------------------------------------------------
   Utilidades
   -------------------------------------------------------------------------- */

function escapar(valor) {
  return String(valor == null ? '' : valor)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function semAcento(texto) {
  return String(texto || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

function linkOficial(id) {
  return LINK_CAPES + encodeURIComponent(String(id));
}

function urlPdf(item) {
  const parametros = new URLSearchParams({
    id: String(item.id),
    titulo: item.nomeProducao || '',
    ano: String(item.anoBase || ''),
    ies: item.siglaIes || '',
  });
  return PDF_API + '/api/pdf?' + parametros.toString();
}

async function verificarPdfApi() {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 1500);
  try {
    const resposta = await fetch(PDF_API + '/api/health', { cache: 'no-store', signal: ctrl.signal });
    if (!resposta.ok) return;
    const dados = await resposta.json();
    estado.pdfApi = Boolean(dados.ok);
  } catch {
    estado.pdfApi = false;
  } finally {
    clearTimeout(timer);
  }
}

function esperar(ms, signal) {
  return new Promise((resolver, rejeitar) => {
    const timer = setTimeout(resolver, ms);
    if (signal) {
      signal.addEventListener('abort', () => {
        clearTimeout(timer);
        rejeitar(new DOMException('Aborted', 'AbortError'));
      }, { once: true });
    }
  });
}

/* Uma chamada com limite de tempo. O gateway da CAPES eventualmente demora
   ou devolve 5xx sem cabeçalhos de CORS; nesses casos o fetch "falha". */
async function chamarApi(caminho, opcoes = {}) {
  const externo = opcoes.signal;
  const limite = opcoes.timeoutMs || 25000;

  if (externo && externo.aborted) throw new DOMException('Aborted', 'AbortError');

  const interno = new AbortController();
  let estourou = false;

  const timer = setTimeout(() => {
    estourou = true;
    interno.abort();
  }, limite);

  const repassar = () => interno.abort();
  if (externo) externo.addEventListener('abort', repassar, { once: true });

  try {
    const resposta = await fetch(API + caminho, {
      signal: interno.signal,
      headers: { Accept: 'application/json' },
    });
    if (!resposta.ok) throw new Error('HTTP ' + resposta.status);
    return await resposta.json();
  } catch (erro) {
    if (estourou) throw new Error('Tempo esgotado');
    throw erro;
  } finally {
    clearTimeout(timer);
    if (externo) externo.removeEventListener('abort', repassar);
  }
}

async function api(caminho, opcoes = {}) {
  const tentativas = opcoes.tentativas || 3;
  let ultimoErro;

  for (let tentativa = 0; tentativa < tentativas; tentativa++) {
    try {
      return await chamarApi(caminho, opcoes);
    } catch (erro) {
      ultimoErro = erro;
      if (erro.name === 'AbortError' || (opcoes.signal && opcoes.signal.aborted)) throw erro;
      if (tentativa < tentativas - 1) await esperar(400 * (tentativa + 1), opcoes.signal);
    }
  }

  throw ultimoErro;
}

function consultaUrl(parametros) {
  return Object.entries(parametros)
    .filter(([, v]) => v !== undefined && v !== null && v !== '')
    .map(([k, v]) => encodeURIComponent(k) + '=' + encodeURIComponent(v)
      .replace(/%20/g, '+'))
    .join('&');
}

/* Converte textos em CAIXA ALTA (comuns nos registros antigos da CAPES)
   para caixa de frase, preservando siglas conhecidas. */
const SIGLAS = new Set([
  'TEA', 'TDAH', 'EAD', 'PNE', 'BNCC', 'ENEM', 'ENADE', 'IDEB', 'PIBID', 'CAPES',
  'CNPQ', 'MEC', 'LDB', 'DCN', 'PCN', 'EJA', 'PROEJA', 'PRONERA', 'PNAE', 'SUS',
  'ODS', 'ONU', 'UNESCO', 'OCDE', 'IBGE', 'INEP', 'SAEB', 'PISA', 'TIMSS',
  'PIRLS', 'STEM', 'STEAM', 'TPACK', 'CTS', 'CTSA', 'ZDP', 'TIC', 'TICS', 'TDIC',
  'TDICS', 'IA', 'RPG', 'HQ', 'HQS', 'PDF', 'EJA', 'PROUNI', 'FIES',
  'IF', 'IFS', 'IFSC', 'IFRS', 'IFSP', 'UTFPR', 'UFRGS', 'USP', 'UNICAMP',
  'COVID', 'UDESC', 'UFSC', 'UFRN', 'UFRJ', 'UFMG', 'UFBA', 'UFPE', 'UNB',
  'UNESP', 'PUC', 'PUCSP', 'PUCRS', 'PUCRJ', 'PUCMG', 'PUCPR', 'UFPR', 'UFSM',
  'UFES', 'UFPA', 'UFAM', 'UFMA', 'UFPI', 'UFC', 'UECE', 'UEPG', 'UNIOESTE',
  'FURB', 'UNIVALI', 'UNISINOS', 'ULBRA', 'UNIPAMPA', 'FURG', 'UFPEL', 'CEFET',
  'IFRN', 'IFTM', 'UNIFESP', 'UFABC', 'UFOP', 'UFSJ', 'UFTM', 'UEMG', 'UEPA',
  'UEA', 'UFAC', 'UFRR', 'UFRO', 'UFMT', 'UFMS', 'UFG', 'UCDB', 'UNEB', 'UEMS',
]);

const MINUSCULAS = new Set([
  'a', 'o', 'as', 'os', 'de', 'da', 'do', 'das', 'dos', 'e', 'em', 'na', 'no',
  'nas', 'nos', 'por', 'para', 'com', 'sem', 'sob', 'sobre', 'entre', 'ao', 'aos',
  'à', 'às', 'um', 'uma', 'uns', 'umas', 'que', 'se', 'ou', 'como', 'após', 'até',
  'pelo', 'pela', 'pelos', 'pelas', 'num', 'numa',
]);

/* Nomes próprios que aparecem com frequência nos títulos e resumos e que
   merecem maiúscula mesmo quando o texto todo vem em CAIXA ALTA. */
const PROPRIOS = new Set([
  'BRASIL', 'BRASÍLIA', 'ACRE', 'ALAGOAS', 'AMAPÁ', 'AMAZONAS', 'BAHIA', 'CEARÁ',
  'GOIÁS', 'MARANHÃO', 'PARANÁ', 'PERNAMBUCO', 'PIAUÍ', 'SERGIPE', 'TOCANTINS',
  'RONDÔNIA', 'RORAIMA', 'SANTA', 'CATARINA', 'MINAS', 'GERAIS', 'JANEIRO',
  'PAULO', 'GROSSO', 'PORTUGAL', 'ESPANHA', 'FRANÇA', 'ITÁLIA', 'ALEMANHA',
  'CHINA', 'JAPÃO', 'MÉXICO', 'ARGENTINA', 'CHILE', 'COLÔMBIA', 'CUBA',
  'ANGOLA', 'MOÇAMBIQUE', 'AMÉRICA', 'EUROPA', 'ÁFRICA', 'ÁSIA', 'NORDESTE',
  'SUDESTE', 'AMAZÔNIA', 'PANTANAL', 'CERRADO', 'ATLÂNTICO', 'LIBRAS',
]);

function ehCaixaAlta(texto) {
  const bruto = String(texto || '');
  const letras = bruto.match(/\p{L}/gu);
  if (!letras || letras.length < 6) return false;

  // Conta palavras que estão inteiras em caixa alta. É mais estável que a
  // proporção de letras quando o registro mistura um trecho gritado com outro
  // escrito normalmente (acontece em títulos antigos da CAPES).
  const palavras = bruto.split(/\s+/).filter((p) => /\p{L}/u.test(p));
  if (!palavras.length) return false;

  const gritando = palavras.filter((p) => {
    const limpa = p.replace(/[^\p{L}]/gu, '');
    return limpa.length >= 2 && limpa === limpa.toLocaleUpperCase('pt-BR');
  }).length;

  const minusculas = letras.filter((c) => c === c.toLocaleLowerCase('pt-BR')).length;

  return gritando / palavras.length > 0.5 || minusculas / letras.length < 0.2;
}

function caixaFrase(texto) {
  if (!texto) return '';
  const partes = String(texto).trim().split(/\s+/);
  let inicio = true;
  const saida = partes.map((palavra) => {
    const limpa = palavra.replace(/[^\p{L}]/gu, '');
    const sigla = limpa.length >= 2 && limpa.length <= 5
      && limpa === limpa.toLocaleUpperCase('pt-BR')
      && (SIGLAS.has(limpa) || !/[AEIOUÁÉÍÓÚÂÊÔÃÕ]/i.test(limpa));

    let p = palavra.toLocaleLowerCase('pt-BR');
    if (sigla) p = palavra;
    else if (PROPRIOS.has(limpa)) p = p.replace(/\p{L}/u, (c) => c.toLocaleUpperCase('pt-BR'));

    // Cidades seguidas da sigla do estado: PETROLINA-PE -> Petrolina-PE.
    if (/-[A-Z]{2}$/.test(palavra)) {
      p = p.replace(/-([a-z]{2})$/, (m, uf) => '-' + uf.toLocaleUpperCase('pt-BR'));
      p = p.replace(/\p{L}/u, (c) => c.toLocaleUpperCase('pt-BR'));
    }

    if (inicio && /\p{L}/u.test(p)) {
      p = p.replace(/\p{L}/u, (c) => c.toLocaleUpperCase('pt-BR'));
    }
    inicio = /[.!?]$/.test(palavra);
    return p;
  });
  return saida.join(' ');
}

function tituloBonito(texto) {
  const t = String(texto || '').trim();
  if (!t) return '(sem título)';
  return ehCaixaAlta(t) ? caixaFrase(t) : t;
}

function areaBonita(texto) {
  if (!texto) return '';
  const t = String(texto).trim();
  // A CAPES grava a área sempre em caixa alta.
  return t === t.toLocaleUpperCase('pt-BR') ? caixaFrase(t) : t;
}

function instituicaoBonita(nome) {
  const n = String(nome || '').trim();
  if (!n) return '';
  return ehCaixaAlta(n) ? nomeBonito(n) : n;
}

function programaBonito(nome) {
  const n = String(nome || '').trim();
  if (!n) return '';
  return ehCaixaAlta(n) ? caixaFrase(n) : n;
}

function nomeBonito(nome) {
  const n = String(nome || '').trim();
  if (!n) return '';
  if (!ehCaixaAlta(n)) return n;
  return n.toLocaleLowerCase('pt-BR').split(/\s+/).map((palavra, i) => {
    if (i > 0 && MINUSCULAS.has(palavra)) return palavra;
    return palavra.replace(/\p{L}/u, (c) => c.toLocaleUpperCase('pt-BR'));
  }).join(' ');
}

function grauBonito(grau) {
  const g = String(grau || '').trim();
  if (!g) return '';
  const minusculo = g.toLocaleLowerCase('pt-BR');
  if (minusculo.includes('doutorado') && minusculo.includes('profission')) return 'Doutorado profissional';
  if (minusculo.includes('doutorado')) return 'Doutorado';
  if (minusculo.includes('profission')) return 'Mestrado profissional';
  if (minusculo.includes('mestrado')) return 'Mestrado';
  return g;
}

function classeSelo(grau) {
  const g = String(grau || '').toLocaleLowerCase('pt-BR');
  if (g.includes('doutorado')) return 'doutorado';
  if (g.includes('profission')) return 'profissional';
  return 'mestrado';
}

function selo(grau) {
  const rotulo = grauBonito(grau) || 'Trabalho';
  return `<span class="selo selo--${classeSelo(grau)}">${escapar(rotulo)}</span>`;
}

function grauDoItem(item, detalhe) {
  const autores = (detalhe && detalhe.autores) || item.autores || [];
  const discente = autores.find((a) => String(a.tipoVinculo || '').toLocaleLowerCase('pt-BR').startsWith('discente'))
    || autores[0];
  const grau = (discente && discente.grauAcademico) || item.grauAcademico;
  if (grau) return grau;
  return String(item.nomeSubTipoProducao || '').toUpperCase() === 'TESE' ? 'Doutorado' : 'Mestrado';
}

function ufDoItem(item, detalhe) {
  const base = window.CAPES_IES || {};
  if (detalhe && detalhe.idIes && base.byId && base.byId[String(detalhe.idIes)]) {
    return base.byId[String(detalhe.idIes)][1] || '';
  }
  if (item.siglaIes && base.bySigla && base.bySigla[item.siglaIes]) {
    return base.bySigla[item.siglaIes][0] || '';
  }
  return '';
}

function textoLimpo(valor, preservarParagrafos = false) {
  if (!valor) return '';

  const comQuebras = String(valor)
    .replace(/<\s*br\s*\/?>/gi, '\n')
    .replace(/<\/\s*p\s*>/gi, '\n\n');

  const doc = new DOMParser().parseFromString(comQuebras, 'text/html');
  const texto = (doc.body.textContent || '').replace(/\r/g, '');

  if (!preservarParagrafos) return texto.replace(/\s+/g, ' ').trim();

  // Quebras simples são só quebra de linha da origem (os resumos antigos vêm
  // com uma linha a cada ~100 caracteres). Só linha em branco separa parágrafo.
  return texto
    .replace(/\n{2,}/g, '\u0000')
    .replace(/\n/g, ' ')
    .replace(/[ \t]+/g, ' ')
    .split('\u0000')
    .map((paragrafo) => paragrafo.trim())
    .filter(Boolean)
    .join('\n\n');
}

function resumoBonito(valor, preservarParagrafos = false) {
  const texto = textoLimpo(valor, preservarParagrafos);
  if (!texto) return '';

  if (!ehCaixaAlta(texto)) return texto;

  if (!preservarParagrafos) return caixaFrase(texto);

  return texto
    .split(/\n{2,}/)
    .map((paragrafo) => (paragrafo && ehCaixaAlta(paragrafo) ? caixaFrase(paragrafo) : paragrafo))
    .join('\n\n');
}

function idiomaBonito(valor) {
  const v = String(valor || '').trim();
  const mapa = {
    'PORTUGUES': 'Português', 'PORTUGUÊS': 'Português',
    'INGLES': 'Inglês', 'INGLÊS': 'Inglês', 'ENGLISH': 'Inglês',
    'ESPANHOL': 'Espanhol', 'SPANISH': 'Espanhol',
    'FRANCES': 'Francês', 'FRANCÊS': 'Francês', 'FRENCH': 'Francês',
  };
  return mapa[v.toLocaleUpperCase('pt-BR')] || (v ? caixaFrase(v) : '');
}

function toast(mensagem) {
  const el = $('#toast');
  el.textContent = mensagem;
  el.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => { el.hidden = true; }, 2800);
}

/* --------------------------------------------------------------------------
   URL e controles
   -------------------------------------------------------------------------- */

function lerUrl() {
  const p = new URLSearchParams(location.search);
  const area = (p.get('area') || '').toLocaleUpperCase('pt-BR');
  estado.q = (p.get('q') || '').trim();
  const escopo = p.get('escopo') || '';
  estado.escopo = (escopo === 'titulo' || escopo === 'resumo') ? escopo : 'titulo,resumo';
  estado.exato = p.get('exato') === '1' || p.get('exato') === 'true';
  estado.area = (area === 'EDUCAÇÃO' || area === 'ENSINO') ? area : 'ambas';
  estado.de = p.get('de') || '';
  estado.ate = p.get('ate') || '';
  const tipo = (p.get('tipo') || '').toLocaleUpperCase('pt-BR');
  estado.tipo = tipo === 'DISSERTAÇÃO' ? 'MESTRADO' : tipo === 'TESE' ? 'DOUTORADO' : tipo;
  estado.ies = (p.get('ies') || '').toLocaleUpperCase('pt-BR');
  estado.uf = (p.get('uf') || '').toLocaleUpperCase('pt-BR');
  estado.regiao = (p.get('regiao') || '').toLocaleUpperCase('pt-BR');
  estado.dependencia = (p.get('dep') || '').toLocaleUpperCase('pt-BR');
  estado.pagina = Math.max(1, parseInt(p.get('pagina'), 10) || 1);
}

function escreverUrl() {
  const p = new URLSearchParams();
  if (estado.q) p.set('q', estado.q);
  if (estado.escopo !== 'titulo,resumo') p.set('escopo', estado.escopo);
  if (estado.exato) p.set('exato', '1');
  if (estado.area !== 'ambas') p.set('area', estado.area);
  if (estado.de) p.set('de', estado.de);
  if (estado.ate) p.set('ate', estado.ate);
  if (estado.tipo) p.set('tipo', estado.tipo);
  if (estado.ies) p.set('ies', estado.ies);
  if (estado.uf) p.set('uf', estado.uf);
  if (estado.regiao) p.set('regiao', estado.regiao);
  if (estado.dependencia) p.set('dep', estado.dependencia);
  if (estado.pagina > 1) p.set('pagina', String(estado.pagina));
  const nova = p.toString() ? location.pathname + '?' + p.toString() : location.pathname;
  history.replaceState(null, '', nova);
}

function aplicarControles() {
  $('#q').value = estado.q;
  $('#ano-de').value = estado.de;
  $('#ano-ate').value = estado.ate;
  $('#tipo').value = estado.tipo;
  $('#ies').value = estado.ies;
  $('#uf').value = estado.uf;
  $('#regiao').value = estado.regiao;
  $('#dependencia').value = estado.dependencia;

  for (const botao of $$('.seg button')) {
    botao.setAttribute('aria-pressed', String(botao.dataset.area === estado.area));
  }
  for (const botao of $$('.seg-escopo button')) {
    botao.setAttribute('aria-pressed', String(botao.dataset.escopo === estado.escopo));
  }
  $('#exato').checked = estado.exato;
}

function lerCampos() {
  estado.q = $('#q').value.trim();
  estado.de = $('#ano-de').value;
  estado.ate = $('#ano-ate').value;

  if (estado.de && estado.ate && Number(estado.de) > Number(estado.ate)) {
    [estado.de, estado.ate] = [estado.ate, estado.de];
    $('#ano-de').value = estado.de;
    $('#ano-ate').value = estado.ate;
  }

  estado.tipo = $('#tipo').value;
  estado.uf = $('#uf').value;
  estado.regiao = $('#regiao').value;
  estado.dependencia = $('#dependencia').value;

  const resolvida = resolverIes($('#ies').value);
  estado.ies = resolvida.sigla;
  if (resolvida.ok && resolvida.sigla) $('#ies').value = resolvida.sigla;

  const dica = $('#dica-ies');
  if (!resolvida.ok) {
    dica.hidden = false;
    dica.textContent = `“${$('#ies').value.trim()}” não está na lista de instituições. Confira a sigla.`;
  } else {
    dica.hidden = true;
    dica.textContent = '';
  }
}

function resolverIes(valor) {
  const v = String(valor || '').trim();
  if (!v) return { sigla: '', ok: true };

  const base = window.CAPES_IES || { bySigla: {} };
  const bruto = v.split('—')[0].split(' - ')[0].trim();
  const sigla = bruto.toLocaleUpperCase('pt-BR');

  if (base.bySigla[sigla]) return { sigla, ok: true };

  const alvo = semAcento(v.toLocaleLowerCase('pt-BR'));
  const achados = Object.entries(base.bySigla).filter(([, dados]) =>
    semAcento(String(dados[2] || '').toLocaleLowerCase('pt-BR')).includes(alvo));

  if (achados.length === 1) return { sigla: achados[0][0], ok: true };
  return { sigla, ok: false };
}

function preencherAnos() {
  const anos = estado.anos.length
    ? estado.anos
    : Array.from({ length: 38 }, (_, i) => ({ ano: 1987 + i, total: 0 }));

  const ordenados = anos.slice().sort((a, b) => b.ano - a.ano);
  const opcoes = ordenados.map((a) => `<option value="${a.ano}">${a.ano}</option>`).join('');
  $('#ano-de').innerHTML = '<option value="">de</option>' + opcoes;
  $('#ano-ate').innerHTML = '<option value="">até</option>' + opcoes;
}

function preencherIes() {
  const base = window.CAPES_IES || { bySigla: {} };
  const lista = $('#lista-ies');
  const siglas = Object.keys(base.bySigla).sort((a, b) => a.localeCompare(b, 'pt-BR'));
  lista.innerHTML = siglas.map((sigla) => {
    const info = base.bySigla[sigla];
    return `<option value="${escapar(sigla)}" label="${escapar(info[2] || '')}"></option>`;
  }).join('');
}

function preencherFiltrosTerritoriais() {
  const grupos = (window.CAPES_IES && window.CAPES_IES.grupos) || {};

  const preencher = (seletor, valores, rotuloTodos) => {
    const select = $(seletor);
    if (!select) return;
    const atual = select.value;
    select.innerHTML = `<option value="">${rotuloTodos}</option>` + valores
      .map(([valor, texto]) => `<option value="${escapar(valor)}">${escapar(texto)}</option>`)
      .join('');
    select.value = atual;
  };

  const ufs = Object.keys(grupos.uf || {}).sort((a, b) => a.localeCompare(b, 'pt-BR'));
  preencher('#uf', ufs.map((uf) => [uf, uf]), 'Todas');

  const nomesRegiao = {
    'CENTRO-OESTE': 'Centro-Oeste', 'NORDESTE': 'Nordeste', 'NORTE': 'Norte',
    'SUDESTE': 'Sudeste', 'SUL': 'Sul',
  };
  const regioes = Object.keys(grupos.regiao || {}).sort((a, b) => a.localeCompare(b, 'pt-BR'));
  preencher('#regiao', regioes.map((r) => [r, nomesRegiao[r] || caixaFrase(r)]), 'Todas');

  const nomesDep = {
    'FEDERAL': 'Federal', 'ESTADUAL': 'Estadual', 'MUNICIPAL': 'Municipal',
    'PRIVADA': 'Privada', 'ESTRANGEIRA': 'Estrangeira',
  };
  const deps = Object.keys(grupos.dependencia || {}).sort((a, b) => a.localeCompare(b, 'pt-BR'));
  preencher('#dependencia', deps.map((d) => [d, nomesDep[d] || caixaFrase(d)]), 'Todas');
}

function idsFiltrados() {
  const grupos = (window.CAPES_IES && window.CAPES_IES.grupos) || {};
  let conjunto = null;

  const restringir = (lista) => {
    if (!Array.isArray(lista)) return;
    const permitidas = new Set(lista);
    conjunto = conjunto
      ? new Set([...conjunto].filter((id) => permitidas.has(id)))
      : new Set(lista);
  };

  if (estado.uf) restringir(grupos.uf && grupos.uf[estado.uf]);
  if (estado.regiao) restringir(grupos.regiao && grupos.regiao[estado.regiao]);
  if (estado.dependencia) restringir(grupos.dependencia && grupos.dependencia[estado.dependencia]);

  return conjunto;
}

function atualizarBase() {
  const numero = fmt.format(estado.baseTotal);
  const hero = $('#total-base');
  if (hero) hero.textContent = numero;
  const rodape = $('#total-base-rodape');
  if (rodape) rodape.textContent = numero;
}

/* --------------------------------------------------------------------------
   Facetas (áreas, anos, tipos) e metadados de apoio
   -------------------------------------------------------------------------- */

async function carregarFacetas() {
  const facetas = await api('/facetas/data/catalogo/producao?totalizar=true');
  if (!Array.isArray(facetas)) return;

  const ano = facetas.find((f) => f.key === 'ano-base');
  if (ano && Array.isArray(ano.values)) {
    estado.anos = ano.values
      .map((v) => ({ ano: Number(v.key), total: Number(v.total) || 0 }))
      .filter((v) => Number.isFinite(v.ano))
      .sort((a, b) => a.ano - b.ano);
  }

  const area = facetas.find((f) => f.key === 'nome-area-avaliacao');
  if (area && Array.isArray(area.values)) {
    for (const v of area.values) {
      const nome = String(v.value || '').trim().toLocaleUpperCase('pt-BR');
      if (nome === 'EDUCAÇÃO' || nome === 'ENSINO') estado.areas[nome] = v.key;
    }
    const base = area.values
      .filter((v) => ['EDUCAÇÃO', 'ENSINO'].includes(String(v.value || '').trim().toLocaleUpperCase('pt-BR')))
      .reduce((soma, v) => soma + (Number(v.total) || 0), 0);
    if (base > 0) estado.baseTotal = base;
  }

  const tipo = facetas.find((f) => f.key === 'nome-sub-tipo-producao');
  if (tipo && Array.isArray(tipo.values)) {
    for (const v of tipo.values) {
      const nome = String(v.value || '').trim().toLocaleUpperCase('pt-BR');
      if (nome === 'TESE' || nome === 'DISSERTAÇÃO') estado.tipos[nome] = v.key;
    }
  }
}

/* --------------------------------------------------------------------------
   Montagem da consulta
   -------------------------------------------------------------------------- */

function anosDaConsulta() {
  const todos = estado.anos.length
    ? estado.anos.map((a) => a.ano)
    : Array.from({ length: 38 }, (_, i) => 1987 + i);

  const menor = Math.min(...todos);
  const maior = Math.max(...todos);
  const de = estado.de ? Number(estado.de) : menor;
  const ate = estado.ate ? Number(estado.ate) : maior;

  return todos.filter((ano) => ano >= de && ano <= ate);
}

const GRAUS = {
  MESTRADO: { subtipo: 'DISSERTAÇÃO' },
  DOUTORADO: { subtipo: 'TESE' },
  MESTRADO_PROFISSIONAL: { subtipo: 'DISSERTAÇÃO', profissionais: 'mestrado' },
  DOUTORADO_PROFISSIONAL: { subtipo: 'TESE', profissionais: 'doutorado' },
};

function montarQuery() {
  const partes = [];

  const chaves = estado.area === 'ambas'
    ? [estado.areas['EDUCAÇÃO'], estado.areas['ENSINO']]
    : [estado.areas[estado.area]];

  partes.push(`nome-area-avaliacao:(${chaves.filter(Boolean).join('*')})`);

  const anos = anosDaConsulta();
  const totalAnos = estado.anos.length || 38;
  if (anos.length && anos.length < totalAnos) {
    partes.push(`ano-base:(${anos.join('*')})`);
  }

  const grau = GRAUS[estado.tipo];
  if (grau) {
    const subtipo = estado.tipos[grau.subtipo];
    if (subtipo) partes.push(`nome-sub-tipo-producao:(${subtipo})`);

    if (grau.profissionais) {
      const dados = window.CAPES_IES && window.CAPES_IES.programasProfissionais;
      const ids = (dados && dados[grau.profissionais]) || [];
      partes.push(ids.length ? `id-programa:(${ids.join('*')})` : 'id-programa:(0)');
    }
  }

  // UF, região e dependência viram uma lista de ids internos de IES.
  const grupo = idsFiltrados();

  if (estado.ies) {
    const dadosIes = window.CAPES_IES && window.CAPES_IES.bySigla
      ? window.CAPES_IES.bySigla[estado.ies] : null;
    const idIes = dadosIes ? String(dadosIes[1]) : '';

    if (grupo) {
      partes.push(idIes && grupo.has(idIes) ? `id-ies:(${idIes})` : 'id-ies:(0)');
    } else if (idIes) {
      partes.push(`id-ies:(${idIes})`);
    } else {
      partes.push(`sigla-ies:(${estado.ies})`);
    }
  } else if (grupo) {
    partes.push(grupo.size ? `id-ies:(${[...grupo].sort().join('*')})` : 'id-ies:(0)');
  }

  return partes.join(';');
}

function textoBusca() {
  const q = estado.q.trim();
  if (!q || !estado.exato) return q;
  return '"' + q.replace(/^"+|"+$/g, '').trim() + '"';
}

function parametrosLista(pagina, tamanho) {
  // Consultas com listas de ids (IES, UF/região/dependência ou grau
  // profissional) ficam lentas no serviço quando pedimos o total; nesses
  // casos o total é omitido e a paginação avança enquanto houver resultados.
  const grau = GRAUS[estado.tipo];
  const comIds = Boolean(estado.ies) || Boolean(idsFiltrados()) || Boolean(grau && grau.profissionais);

  return consultaUrl({
    query: montarQuery(),
    search: textoBusca(),
    page: pagina,
    size: tamanho,
    totalizar: comIds ? undefined : 'true',
  });
}

/* --------------------------------------------------------------------------
   Busca
   -------------------------------------------------------------------------- */

async function buscar({ rolar = false } = {}) {
  if (estado.q && estado.escopo !== 'titulo,resumo') {
    return buscarComEscopo({ rolar });
  }

  estado.scan = null;
  const seq = ++estado.seq;

  if (estado.ctrl) estado.ctrl.abort();
  estado.ctrl = new AbortController();

  estado.total = null;
  estado.itens = [];
  estado.cartoes.clear();
  $('#paginacao').hidden = true;
  $('#estado').hidden = true;
  esconderPlaceholders();
  mostrarCarregando();

  $('#subtitulo-resultados').textContent = 'Consultando o catálogo da CAPES…';

  try {
    const dados = await api('/data/catalogo/producao?' + parametrosLista(estado.pagina - 1, POR_PAGINA), {
      signal: estado.ctrl.signal,
    });
    if (seq !== estado.seq) return;

    const itens = Array.isArray(dados.content) ? dados.content : [];
    estado.total = (typeof dados.size === 'number' && dados.size >= 0) ? dados.size : null;

    // Um filtro mais restrito pode deixar a página atual além do fim.
    if (estado.total !== null && estado.pagina > 1) {
      const ultima = Math.max(1, Math.ceil(estado.total / POR_PAGINA));
      if (estado.pagina > ultima) {
        estado.pagina = ultima;
        return buscar({ rolar });
      }
    }

    estado.itens = itens;

    renderizarLista(itens);
    renderizarCabecalho(itens.length);
    renderizarPaginacao(itens.length);
    escreverUrl();

    if (rolar) rolarParaResultados();

    hidratar(itens);
  } catch (erro) {
    if (erro.name === 'AbortError' || seq !== estado.seq) return;
    mostrarErro(erro.message === 'Tempo esgotado'
      ? 'O catálogo da CAPES demorou para responder. Tente novamente em instantes.'
      : '');
    console.error(erro);
  } finally {
    if (seq === estado.seq) esconderPlaceholders();
  }
}

/* --------------------------------------------------------------------------
   Busca restrita a título ou resumo
   A API não expõe um filtro por campo. Nestes casos ela é usada como fonte de
   candidatos e o site confere o termo no campo escolhido.
   -------------------------------------------------------------------------- */

const SCAN_MAX_PAGINAS = 8;

function termosBusca() {
  const texto = estado.q.replace(/^"+|"+$/g, '').trim();
  if (!texto) return [];
  return semAcento(texto.toLocaleLowerCase('pt-BR')).split(/\s+/).filter(Boolean);
}

function combinaTexto(texto, termos) {
  const alvo = semAcento(String(texto || '').toLocaleLowerCase('pt-BR'));
  if (!termos.length) return true;
  if (estado.exato) return alvo.includes(termos.join(' '));
  return termos.every((termo) => alvo.includes(termo));
}

async function mapLimit(itens, limite, fn) {
  const fila = itens.slice();
  const trabalhadores = Array.from({ length: Math.min(limite, fila.length) }, async () => {
    while (fila.length) await fn(fila.shift());
  });
  await Promise.all(trabalhadores);
}

function tamanhoScan() {
  const grau = GRAUS[estado.tipo];
  const temFiltro = Boolean(
    estado.de || estado.ate || estado.ies || estado.uf ||
    estado.regiao || estado.dependencia || (grau && grau.profissionais)
  );
  return temFiltro ? POR_PAGINA : 50;
}

async function buscarComEscopo({ rolar = false, mais = false } = {}) {
  const seq = ++estado.seq;

  if (!mais) {
    if (estado.ctrl) estado.ctrl.abort();
    estado.ctrl = new AbortController();
    estado.total = null;
    estado.itens = [];
    estado.cartoes.clear();
    estado.scan = {
      apiPage: 0,
      seen: new Set(),
      matches: [],
      mostrados: 0,
      esgotado: false,
      limite: false,
    };
    $('#paginacao').hidden = true;
    $('#estado').hidden = true;
    $('#lista').innerHTML = '';
    $('#subtitulo-resultados').textContent = estado.escopo === 'titulo'
      ? 'Buscando no título…'
      : 'Buscando no resumo… (pode levar alguns segundos)';
    mostrarCarregando();
  } else if (!estado.ctrl) {
    estado.ctrl = new AbortController();
  }

  const botaoMais = $('#paginacao [data-mais]');
  if (botaoMais) {
    botaoMais.disabled = true;
    botaoMais.textContent = 'Buscando…';
  }

  try {
    const scan = estado.scan;
    const termos = termosBusca();
    const alvo = scan.mostrados + POR_PAGINA;
    const limite = scan.apiPage + SCAN_MAX_PAGINAS;

    while (scan.matches.length < alvo && !scan.esgotado && scan.apiPage < limite) {
      const tamanho = tamanhoScan();
      const dados = await api('/data/catalogo/producao?' + parametrosLista(scan.apiPage, tamanho), {
        signal: estado.ctrl.signal,
      });
      if (seq !== estado.seq) return;

      scan.apiPage++;
      const itens = Array.isArray(dados.content) ? dados.content : [];
      if (itens.length < tamanho) scan.esgotado = true;

      const novos = itens.filter((item) => !scan.seen.has(String(item.id)));
      for (const item of novos) scan.seen.add(String(item.id));

      let detalhes = null;
      if (estado.escopo === 'resumo') {
        detalhes = new Map();
        await mapLimit(novos, 6, async (item) => {
          const det = await detalhe(item.id);
          if (det) detalhes.set(String(item.id), det);
        });
        if (seq !== estado.seq) return;
      }

      for (const item of novos) {
        if (estado.escopo === 'titulo') {
          if (combinaTexto(item.nomeProducao, termos)) scan.matches.push(item);
        } else {
          const det = detalhes && detalhes.get(String(item.id));
          if (det && combinaTexto(textoLimpo(det.resumo), termos)) scan.matches.push(item);
        }
      }
    }

    if (scan.apiPage >= limite && scan.matches.length < alvo) scan.limite = true;

    const novosItens = scan.matches.slice(scan.mostrados, scan.mostrados + POR_PAGINA);
    scan.mostrados += novosItens.length;

    if (novosItens.length) {
      estado.itens.push(...novosItens);
      renderizarLista(novosItens, { anexar: mais });
      renderizarCabecalhoScoped();
      hidratar(novosItens);
    } else if (!mais) {
      mostrarVazioEscopo();
      estado.itens = [];
    }

    renderizarPaginacaoScoped();
    escreverUrl();
    if (rolar) rolarParaResultados();
  } catch (erro) {
    if (erro.name === 'AbortError' || seq !== estado.seq) return;
    console.error(erro);

    const scan = estado.scan;
    if (scan && scan.matches.length > scan.mostrados) {
      // A API oscilou no meio da varredura: mostra o que já foi encontrado.
      const novosItens = scan.matches.slice(scan.mostrados, scan.mostrados + POR_PAGINA);
      scan.mostrados += novosItens.length;
      estado.itens.push(...novosItens);
      renderizarLista(novosItens, { anexar: mais });
      renderizarCabecalhoScoped();
      $('#subtitulo-resultados').innerHTML += ' <span aria-hidden="true">·</span> resultados parciais';
      hidratar(novosItens);
      renderizarPaginacaoScoped();
      escreverUrl();
    } else if (mais) {
      // Não apaga o que já está na tela: apenas avisa e deixa tentar de novo.
      toast('Não foi possível carregar mais resultados agora. Tente de novo.');
      renderizarPaginacaoScoped();
    } else {
      mostrarErro(erro.message === 'Tempo esgotado'
        ? 'O catálogo da CAPES demorou para responder. Tente novamente em instantes.'
        : '');
    }
  } finally {
    if (seq === estado.seq) esconderPlaceholders();
  }
}

function renderizarCabecalhoScoped() {
  const escopoArea = estado.area === 'ambas'
    ? 'em Educação e Ensino'
    : estado.area === 'EDUCAÇÃO' ? 'em Educação' : 'em Ensino';
  const campo = estado.escopo === 'titulo' ? 'no título' : 'no resumo';
  const total = estado.itens.length;

  $('#titulo-resultados').textContent = `Resultados para “${estado.q}”`;
  $('#subtitulo-resultados').innerHTML =
    `Mostrando <strong>${fmt.format(total)}</strong> ${total === 1 ? 'trabalho' : 'trabalhos'} ${escopoArea}`
    + ` <span aria-hidden="true">·</span> busca ${campo}`
    + (estado.exato ? ' · termo exato' : '');
}

function renderizarPaginacaoScoped() {
  const nav = $('#paginacao');
  const scan = estado.scan;
  if (!scan) { nav.hidden = true; return; }

  const temMais = scan.matches.length > scan.mostrados || (!scan.esgotado && !scan.limite);
  if (!temMais) { nav.hidden = true; return; }

  nav.hidden = false;
  nav.innerHTML = '<button type="button" data-mais>Mostrar mais</button>';
}

function mostrarVazioEscopo() {
  const campo = estado.escopo === 'titulo' ? 'título' : 'resumo';
  const el = $('#estado');
  el.hidden = false;
  el.className = 'estado';
  el.innerHTML = `
    <h3>Nenhum trabalho no ${campo}</h3>
    <p>O termo não aparece apenas nesse campo. Tente buscar em título e resumo.</p>
    <button type="button" data-acao="escopo-tudo">Buscar em título e resumo</button>`;
  $('#paginacao').hidden = true;
  $('#lista').innerHTML = '';
}

function mostrarCarregando() {
  const lista = $('#lista');
  lista.innerHTML = '';
  for (let i = 0; i < 3; i++) {
    const card = document.createElement('article');
    card.className = 'card placeholder';
    card.setAttribute('aria-hidden', 'true');
    card.innerHTML = `
      <div class="esqueleto" style="min-height:auto;margin-bottom:12px">
        <i style="height:15px;width:${72 - i * 6}%"></i>
      </div>
      <div class="esqueleto" style="min-height:auto;margin-bottom:14px">
        <i style="height:9px;width:46%"></i>
      </div>
      <div class="esqueleto">
        <i></i><i></i><i></i>
      </div>`;
    lista.appendChild(card);
  }
}

function esconderPlaceholders() {
  $$('#lista .placeholder').forEach((el) => el.remove());
}

function renderizarLista(itens, { anexar = false } = {}) {
  const lista = $('#lista');
  if (!anexar) lista.innerHTML = '';

  if (!itens.length) {
    if (!anexar) mostrarVazio();
    return;
  }

  $('#estado').hidden = true;

  for (const item of itens) {
    const card = montarCartao(item);
    estado.cartoes.set(String(item.id), card);
    lista.appendChild(card);
  }
}

function montarCartao(item) {
  const id = String(item.id);
  const grau = grauDoItem(item, null);
  const ano = item.anoBase || (item.dataPublicacao ? String(item.dataPublicacao).slice(0, 4) : '');
  const uf = ufDoItem(item, null);
  const autores = Array.isArray(item.autores) ? item.autores : [];
  const autor = autores.length ? autores[0].nomePessoa : '';
  const card = document.createElement('article');
  card.className = 'card';
  card.dataset.id = id;

  card.innerHTML = `
    <h3 class="card-titulo">
      <a href="${linkOficial(id)}" target="_blank" rel="noopener">${escapar(tituloBonito(item.nomeProducao))}</a>
    </h3>
    <div class="card-meta">
      ${selo(grau)}
      ${ano ? `<span>${escapar(ano)}</span>` : ''}
      ${item.siglaIes ? `<span>${escapar(item.siglaIes)}</span>` : ''}
      ${uf ? `<span>${escapar(uf)}</span>` : ''}
      ${autor ? `<span class="autor" title="Autoria">${escapar(nomeBonito(autor))}</span>` : ''}
      <span class="area"></span>
    </div>
    <p class="card-resumo esqueleto" aria-label="Carregando resumo">
      <i></i><i></i><i></i>
    </p>
    <div class="card-pe">
      <a class="link-capes" href="${linkOficial(id)}" target="_blank" rel="noopener">
        Abrir no catálogo da CAPES
        <span aria-hidden="true">↗</span>
      </a>
      <div class="card-pe-acoes">
        ${estado.pdfApi ? `<a class="link-pdf" href="${escapar(urlPdf(item))}" target="_blank" rel="noopener" title="Baixar o PDF do trabalho">PDF <span aria-hidden="true">↓</span></a>` : ''}
        <button type="button" class="btn-detalhes" data-detalhe="${escapar(id)}">Ver detalhes</button>
      </div>
    </div>`;

  return card;
}

/* Preenche resumo, área e (quando necessário) a UF, sem refazer o cartão. */
function aplicarDetalhe(id, detalhe) {
  const card = estado.cartoes.get(String(id));
  if (!card || !card.isConnected) return;

  const resumoEl = $('.card-resumo', card);
  const texto = resumoBonito(detalhe.resumo);

  if (resumoEl) {
    resumoEl.classList.remove('esqueleto', 'sem-resumo');
    if (texto) {
      resumoEl.textContent = texto;
      resumoEl.removeAttribute('aria-label');
    } else {
      resumoEl.textContent = 'Resumo não disponível neste registro.';
      resumoEl.classList.add('sem-resumo');
      resumoEl.removeAttribute('aria-label');
    }
  }

  const areaEl = $('.area', card);
  if (areaEl) {
    // A ficha do cartão usa a área de concentração (é o rótulo que aparece
    // ao lado do nome do programa no catálogo); a de conhecimento é o fallback.
    const area = detalhe.nomeAreaConcentracao || detalhe.nomeAreaConhecimento || '';
    areaEl.textContent = areaBonita(area);
  }

  const uf = ufDoItem({ siglaIes: detalhe.siglaIes }, detalhe);
  if (uf && !$$('.card-meta > span', card).some((s) => s.textContent === uf)) {
    const alvo = $('.autor', card);
    if (alvo) alvo.insertAdjacentHTML('afterend', `<span>${escapar(uf)}</span>`);
  }
}

function detalhe(id) {
  const chave = String(id);

  if (!estado.promessas.has(chave)) {
    const promessa = api('/data/catalogo/producao/' + encodeURIComponent(chave))
      .then((dados) => {
        estado.detalhes.set(chave, dados);
        return dados;
      })
      .catch(() => {
        // Libera nova tentativa (o diálogo tenta de novo ao ser aberto).
        estado.promessas.delete(chave);
        return null;
      });
    estado.promessas.set(chave, promessa);
  }

  return estado.promessas.get(chave);
}

async function hidratar(itens) {
  const fila = itens.slice();
  const trabalhadores = Array.from({ length: CONCORRENCIA }, async () => {
    while (fila.length) {
      const item = fila.shift();
      const dados = await detalhe(item.id);
      if (dados) aplicarDetalhe(item.id, dados);
      else marcarSemDetalhe(item.id);
    }
  });
  await Promise.all(trabalhadores);
}

function marcarSemDetalhe(id) {
  const card = estado.cartoes.get(String(id));
  if (!card || !card.isConnected) return;
  const resumoEl = $('.card-resumo', card);
  if (resumoEl) {
    resumoEl.classList.remove('esqueleto');
    resumoEl.classList.add('sem-resumo');
    resumoEl.textContent = 'Resumo não disponível neste registro.';
    resumoEl.removeAttribute('aria-label');
  }
}

/* --------------------------------------------------------------------------
   Cabeçalho dos resultados, estado vazio e erro
   -------------------------------------------------------------------------- */

function renderizarCabecalho(quantidade) {
  const titulo = $('#titulo-resultados');
  const sub = $('#subtitulo-resultados');

  titulo.textContent = estado.q ? `Resultados para “${estado.q}”` : 'Todos os trabalhos';

  const escopo = estado.area === 'ambas'
    ? 'em Educação e Ensino'
    : estado.area === 'EDUCAÇÃO' ? 'em Educação' : 'em Ensino';

  const exato = estado.exato ? ' <span aria-hidden="true">·</span> termo exato' : '';

  if (estado.total !== null) {
    sub.innerHTML = `<strong>${fmt.format(estado.total)}</strong> ${estado.total === 1 ? 'trabalho' : 'trabalhos'} ${escopo}${exato}`;
  } else if (quantidade) {
    sub.innerHTML = `Mostrando <strong>${fmt.format(quantidade)}</strong> ${quantidade === 1 ? 'trabalho' : 'trabalhos'} ${escopo}
      <span aria-hidden="true">·</span> página ${fmt.format(estado.pagina)}${exato}`;
  } else {
    sub.textContent = `Nenhum trabalho ${escopo}`;
  }
}

function mostrarVazio() {
  const el = $('#estado');
  el.hidden = false;
  el.className = 'estado';
  $('#paginacao').hidden = true;
  el.innerHTML = `
    <h3>Nenhum trabalho encontrado</h3>
    <p>Tente termos mais gerais, remova o filtro de instituição ou amplie o intervalo de anos.</p>
    <button type="button" data-acao="limpar-tudo">Limpar busca e filtros</button>`;
}

function mostrarErro(mensagem) {
  const el = $('#estado');
  el.hidden = false;
  el.className = 'estado erro';
  el.innerHTML = `
    <h3>Não foi possível consultar o catálogo</h3>
    <p>${escapar(mensagem || 'O serviço da CAPES pode estar momentaneamente indisponível. Tente novamente em instantes.')}</p>
    <button type="button" data-acao="tentar">Tentar de novo</button>`;
  $('#subtitulo-resultados').textContent = 'Falha na consulta';
  $('#paginacao').hidden = true;
  $('#lista').innerHTML = '';
}

/* --------------------------------------------------------------------------
   Paginação
   -------------------------------------------------------------------------- */

function renderizarPaginacao(quantidade) {
  const nav = $('#paginacao');
  const totalPaginas = estado.total !== null ? Math.ceil(estado.total / POR_PAGINA) : null;
  const temProxima = totalPaginas !== null ? estado.pagina < totalPaginas : quantidade === POR_PAGINA;

  if (estado.pagina === 1 && !temProxima) {
    nav.hidden = true;
    return;
  }

  nav.hidden = false;
  nav.innerHTML = `
    <button type="button" data-pagina="${estado.pagina - 1}" ${estado.pagina <= 1 ? 'disabled' : ''}>
      ← Anterior
    </button>
    <span class="pagina-atual">
      Página <strong>${fmt.format(estado.pagina)}</strong>${totalPaginas ? ` de ${fmt.format(totalPaginas)}` : ''}
    </span>
    <button type="button" data-pagina="${estado.pagina + 1}" ${temProxima ? '' : 'disabled'}>
      Próxima →
    </button>`;
}

function irParaPagina(pagina) {
  if (pagina < 1) return;
  estado.pagina = pagina;
  buscar({ rolar: true });
}

function rolarParaResultados() {
  const alvo = $('#resultados');
  if (!alvo) return;
  const topo = alvo.getBoundingClientRect().top + window.scrollY - 82;
  window.scrollTo({ top: Math.max(0, topo), behavior: 'smooth' });
}

/* --------------------------------------------------------------------------
   Detalhes
   -------------------------------------------------------------------------- */

function abrirDetalhe(id) {
  const chave = String(id);
  const item = estado.itens.find((x) => String(x.id) === chave);
  if (!item) return;

  estado.ultimoFoco = document.activeElement;
  preencherDialogo(item, estado.detalhes.get(chave) || null);

  const dialogo = $('#detalhe');
  if (typeof dialogo.showModal === 'function') dialogo.showModal();
  else dialogo.setAttribute('open', '');

  if (!estado.detalhes.has(chave)) {
    detalhe(chave).then((dados) => { if (dados) preencherDialogo(item, dados); });
  }
}

function preencherDialogo(item, detalhe) {
  const id = String(item.id);
  const grau = grauDoItem(item, detalhe);
  const ano = (detalhe && detalhe.anoBase) || item.anoBase || '';
  const tipo = String((detalhe && detalhe.nomeSubTipoProducao) || item.nomeSubTipoProducao || '').toUpperCase();
  const rotuloTipo = tipo === 'TESE' ? 'Tese' : tipo === 'DISSERTAÇÃO' ? 'Dissertação' : 'Trabalho de conclusão';

  $('#d-badges').innerHTML = `
    ${selo(grau)}
    <span>${escapar(rotuloTipo)}</span>
    ${ano ? `<span aria-hidden="true">·</span><span>${escapar(ano)}</span>` : ''}`;

  $('#d-titulo').textContent = tituloBonito(item.nomeProducao);

  const sigla = (detalhe && detalhe.siglaIes) || item.siglaIes || '';
  const uf = ufDoItem(item, detalhe);
  const programa = programaBonito((detalhe && detalhe.nomePrograma) || item.nomePrograma || '');
  $('#d-sub').textContent = [sigla, uf, programa].filter(Boolean).join(' · ');

  const autores = (detalhe && detalhe.autores) || item.autores || [];
  const nomesAutores = autores.map((a) => nomeBonito(a.nomePessoa)).filter(Boolean).join('; ');
  const orientadores = (detalhe && detalhe.orientadores) || [];
  const nomesOrientadores = orientadores.map((o) => nomeBonito(o.nomePessoa)).filter(Boolean).join('; ');
  const banca = (detalhe && detalhe.banca) || [];
  const nomesBanca = banca.map((b) => nomeBonito(b.nomePessoa)).filter(Boolean).join('; ');
  const ies = instituicaoBonita((detalhe && detalhe.nomeIes) || '');
  const area = (detalhe && detalhe.nomeAreaConhecimento) || '';
  const concentracao = (detalhe && detalhe.nomeAreaConcentracao) || '';
  const areaAvaliacao = (detalhe && detalhe.nomeAreaAvaliacao) ? String(detalhe.nomeAreaAvaliacao).trim() : '';
  const idioma = (detalhe && detalhe.idioma) || '';
  const paginas = (detalhe && detalhe.numeroPaginas) || '';

  const linhas = [
    ['Autoria', nomesAutores],
    ['Orientação', nomesOrientadores],
    ['Instituição', [ies, sigla && uf ? `${sigla} · ${uf}` : sigla].filter(Boolean).join(' — ')],
    ['Programa', programa],
    ['Área de concentração', areaBonita(concentracao)],
    ['Área de conhecimento', areaBonita(area)],
    ['Área de avaliação', areaBonita(areaAvaliacao)],
    ['Idioma', idiomaBonito(idioma)],
    ['Páginas', paginas ? fmt.format(paginas) : ''],
    ['Banca', nomesBanca],
  ].filter(([, valor]) => valor);

  $('#d-meta').innerHTML = linhas
    .map(([rotulo, valor]) => `<dt>${escapar(rotulo)}</dt><dd>${escapar(valor)}</dd>`)
    .join('');

  const resumoEl = $('#d-resumo');
  if (!detalhe) {
    resumoEl.textContent = 'Carregando o resumo completo…';
    resumoEl.style.opacity = '.55';
  } else {
    resumoEl.style.opacity = '';
    resumoEl.textContent = resumoBonito(detalhe.resumo, true) || 'Este registro não tem resumo cadastrado no catálogo.';
  }

  const palavras = String((detalhe && detalhe.palavrasChave) || '')
    .split(/[;•|]/)
    .map((p) => p.trim())
    .filter((p) => p.length > 1);

  const secaoPalavras = $('#d-palavras-secao');
  if (palavras.length) {
    secaoPalavras.hidden = false;
    $('#d-palavras').innerHTML = palavras.map((p) => `<span>${escapar(caixaFrase(p))}</span>`).join('');
  } else {
    secaoPalavras.hidden = true;
    $('#d-palavras').innerHTML = '';
  }

  $('#d-link').href = linkOficial(id);
  const pdf = $('#d-pdf');
  if (estado.pdfApi) {
    pdf.hidden = false;
    pdf.href = urlPdf(item);
  } else {
    pdf.hidden = true;
    pdf.removeAttribute('href');
  }
  $('#d-copiar').dataset.id = id;
}

function fecharDialogo() {
  const dialogo = $('#detalhe');
  if (typeof dialogo.close === 'function') dialogo.close();
  else dialogo.removeAttribute('open');
  if (estado.ultimoFoco && estado.ultimoFoco.focus) estado.ultimoFoco.focus();
}

function citacao(item, detalhe) {
  const autores = (detalhe && detalhe.autores) || item.autores || [];
  const nome = nomeBonito((autores[0] && autores[0].nomePessoa) || '');
  const partes = nome.split(/\s+/).filter(Boolean);
  const sobrenome = (partes.pop() || '').toLocaleUpperCase('pt-BR');
  const prenome = partes.join(' ');
  const autor = [sobrenome, prenome].filter(Boolean).join(', ');

  const titulo = tituloBonito(item.nomeProducao).replace(/[.\s]+$/, '');
  const ano = (detalhe && detalhe.anoBase) || item.anoBase || '';
  const tipo = String((detalhe && detalhe.nomeSubTipoProducao) || item.nomeSubTipoProducao || '').toUpperCase() === 'TESE'
    ? 'Tese' : 'Dissertação';
  const grau = grauBonito(grauDoItem(item, detalhe));
  const programa = programaBonito((detalhe && detalhe.nomePrograma) || item.nomePrograma || '');
  const ies = instituicaoBonita((detalhe && detalhe.nomeIes) || '');
  const uf = ufDoItem(item, detalhe);

  return `${autor}. ${titulo}. ${ano}. ${tipo} (${grau}${programa ? ' em ' + programa : ''}) – ${ies}${uf ? ', ' + uf : ''}, ${ano}.`.replace(/\s+/g, ' ');
}

async function copiarTexto(texto) {
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      await navigator.clipboard.writeText(texto);
      return true;
    }
  } catch { /* segue para o caminho antigo */ }

  // Funciona também quando a página é aberta por file:// ou em contexto não seguro.
  const area = document.createElement('textarea');
  area.value = texto;
  area.setAttribute('readonly', '');
  area.style.position = 'fixed';
  area.style.opacity = '0';
  document.body.appendChild(area);
  area.select();
  let ok = false;
  try { ok = document.execCommand('copy'); } catch { ok = false; }
  area.remove();
  return ok;
}

async function copiarCitacao(id) {
  const item = estado.itens.find((x) => String(x.id) === String(id));
  if (!item) return;
  const detalheItem = estado.detalhes.get(String(id)) || null;
  const texto = citacao(item, detalheItem);

  if (await copiarTexto(texto)) {
    const botao = $('#d-copiar');
    const original = botao.textContent;
    botao.textContent = 'Citação copiada';
    setTimeout(() => { botao.textContent = original; }, 1800);
  } else {
    toast('Não foi possível copiar automaticamente.');
  }
}

/* --------------------------------------------------------------------------
   CSV
   -------------------------------------------------------------------------- */

function celula(valor) {
  const texto = String(valor == null ? '' : valor).replace(/\s+/g, ' ').trim();
  return '"' + texto.replace(/"/g, '""') + '"';
}

async function baixarCsv() {
  const botao = $('#csv');
  const rotulo = botao.innerHTML;
  botao.disabled = true;
  botao.textContent = 'Preparando…';

  try {
    const linhas = [];
    const lotes = Math.ceil(MAX_CSV / POR_PAGINA);

    for (let p = 0; p < lotes; p++) {
      const dados = await api('/data/catalogo/producao?' + parametrosLista(p, POR_PAGINA));
      const itens = Array.isArray(dados.content) ? dados.content : [];
      linhas.push(...itens);
      if (itens.length < POR_PAGINA) break;
    }

    if (!linhas.length) {
      toast('Não há resultados para exportar.');
      return;
    }

    const cabecalho = ['Título', 'Autoria', 'Ano', 'Grau', 'Instituição', 'UF', 'Programa', 'Link'];
    const corpo = linhas.map((item) => {
      const grau = grauDoItem(item, null);
      return [
        tituloBonito(item.nomeProducao),
        nomeBonito((item.autores && item.autores[0] && item.autores[0].nomePessoa) || ''),
        item.anoBase || '',
        grauBonito(grau),
        item.siglaIes || '',
        ufDoItem(item, null),
        item.nomePrograma || '',
        linkOficial(item.id),
      ].map(celula).join(';');
    });

    const csv = '\uFEFF' + [cabecalho.map(celula).join(';'), ...corpo].join('\r\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'capes-educacao-ensino.csv';
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);

    toast(linhas.length >= MAX_CSV
      ? `${fmt.format(MAX_CSV)} primeiros resultados exportados.`
      : `${fmt.format(linhas.length)} ${linhas.length === 1 ? 'resultado exportado' : 'resultados exportados'}.`);
  } catch (erro) {
    console.error(erro);
    toast('Não foi possível gerar o CSV agora.');
  } finally {
    botao.disabled = false;
    botao.innerHTML = rotulo;
  }
}

/* --------------------------------------------------------------------------
   Eventos
   -------------------------------------------------------------------------- */

function ligarEventos() {
  $('#form-busca').addEventListener('submit', (evento) => {
    evento.preventDefault();
    lerCampos();
    estado.pagina = 1;
    buscar({ rolar: true });
  });

  for (const botao of $$('.seg button')) {
    botao.addEventListener('click', () => {
      estado.area = botao.dataset.area;
      for (const outro of $$('.seg button')) {
        outro.setAttribute('aria-pressed', String(outro === botao));
      }
      lerCampos();
      estado.pagina = 1;
      buscar({ rolar: true });
    });
  }

  for (const botao of $$('.seg-escopo button')) {
    botao.addEventListener('click', () => {
      estado.escopo = botao.dataset.escopo;
      for (const outro of $$('.seg-escopo button')) {
        outro.setAttribute('aria-pressed', String(outro === botao));
      }
      lerCampos();
      estado.pagina = 1;
      estado.scan = null;
      buscar({ rolar: true });
    });
  }

  $('#exato').addEventListener('change', () => {
    estado.exato = $('#exato').checked;
    lerCampos();
    estado.pagina = 1;
    estado.scan = null;
    buscar({ rolar: true });
  });

  for (const id of ['#ano-de', '#ano-ate', '#tipo', '#uf', '#regiao', '#dependencia']) {
    $(id).addEventListener('change', () => {
      lerCampos();
      estado.pagina = 1;
      buscar();
    });
  }

  $('#ies').addEventListener('change', () => {
    lerCampos();
    estado.pagina = 1;
    buscar();
  });

  $('#ies').addEventListener('input', () => {
    const dica = $('#dica-ies');
    dica.hidden = true;
  });

  $('#ies').addEventListener('keydown', (evento) => {
    if (evento.key === 'Enter') {
      evento.preventDefault();
      lerCampos();
      estado.pagina = 1;
      buscar({ rolar: true });
    }
  });

  $('#limpar').addEventListener('click', () => limparFiltros());

  for (const botao of $$('.sugestoes button')) {
    botao.addEventListener('click', () => {
      $('#q').value = botao.dataset.q;
      lerCampos();
      estado.pagina = 1;
      buscar({ rolar: true });
    });
  }

  $('#csv').addEventListener('click', baixarCsv);

  $('#estado').addEventListener('click', (evento) => {
    const acao = evento.target.closest('[data-acao]');
    if (!acao) return;
    if (acao.dataset.acao === 'limpar') limparFiltros();
    if (acao.dataset.acao === 'limpar-tudo') limparFiltros({ limparBusca: true });
    if (acao.dataset.acao === 'escopo-tudo') {
      estado.escopo = 'titulo,resumo';
      estado.exato = false;
      $('#exato').checked = false;
      for (const botao of $$('.seg-escopo button')) {
        botao.setAttribute('aria-pressed', String(botao.dataset.escopo === 'titulo,resumo'));
      }
      estado.scan = null;
      buscar({ rolar: true });
    }
    if (acao.dataset.acao === 'tentar') buscar();
  });

  $('#paginacao').addEventListener('click', (evento) => {
    const mais = evento.target.closest('[data-mais]');
    if (mais) {
      if (!mais.disabled) buscarComEscopo({ mais: true });
      return;
    }

    const botao = evento.target.closest('[data-pagina]');
    if (!botao || botao.disabled) return;
    irParaPagina(Number(botao.dataset.pagina));
  });

  $('#lista').addEventListener('click', (evento) => {
    const botao = evento.target.closest('[data-detalhe]');
    if (botao) abrirDetalhe(botao.dataset.detalhe);
  });

  $('#d-fechar').addEventListener('click', fecharDialogo);

  $('#d-copiar').addEventListener('click', () => {
    const id = $('#d-copiar').dataset.id;
    if (id) copiarCitacao(id);
  });

  const dialogo = $('#detalhe');
  dialogo.addEventListener('click', (evento) => {
    if (evento.target === dialogo) fecharDialogo();
  });
  dialogo.addEventListener('close', () => {
    if (estado.ultimoFoco && estado.ultimoFoco.focus) estado.ultimoFoco.focus();
  });

  // Navegação pelo histórico (voltar/avançar do navegador).
  window.addEventListener('popstate', () => {
    lerUrl();
    preencherAnos();
    aplicarControles();
    buscar();
  });
}

function limparFiltros({ limparBusca = false } = {}) {
  estado.area = 'ambas';
  estado.de = '';
  estado.ate = '';
  estado.tipo = '';
  estado.ies = '';
  estado.uf = '';
  estado.regiao = '';
  estado.dependencia = '';
  estado.pagina = 1;

  if (limparBusca) {
    estado.q = '';
    estado.escopo = 'titulo,resumo';
    estado.exato = false;
    estado.scan = null;
    $('#q').value = '';
    $('#exato').checked = false;
    for (const botao of $$('.seg-escopo button')) {
      botao.setAttribute('aria-pressed', String(botao.dataset.escopo === 'titulo,resumo'));
    }
  }

  $('#ano-de').value = '';
  $('#ano-ate').value = '';
  $('#tipo').value = '';
  $('#ies').value = '';
  $('#uf').value = '';
  $('#regiao').value = '';
  $('#dependencia').value = '';
  $('#dica-ies').hidden = true;

  for (const botao of $$('.seg button')) {
    botao.setAttribute('aria-pressed', String(botao.dataset.area === 'ambas'));
  }

  buscar({ rolar: true });
}

/* --------------------------------------------------------------------------
   Inicialização
   -------------------------------------------------------------------------- */

async function iniciar() {
  lerUrl();
  ligarEventos();
  preencherIes();
  preencherFiltrosTerritoriais();
  preencherAnos();
  atualizarBase();
  aplicarControles();

  // O servidor local (server.py) expõe o PDF; sem ele o site continua
  // funcionando, apenas sem o botão de PDF.
  await verificarPdfApi();

  // A primeira busca começa já, com as áreas padrão; as facetas (anos, totais)
  // chegam em paralelo e só completam os controles.
  buscar();

  carregarFacetas()
    .then(() => {
      preencherAnos();
      $('#ano-de').value = estado.de;
      $('#ano-ate').value = estado.ate;
      atualizarBase();
    })
    .catch((erro) => {
      console.warn('Facetas indisponíveis; usando os valores padrão.', erro);
    });
}

document.addEventListener('DOMContentLoaded', iniciar);
