#!/usr/bin/env python3
"""Servidor local do buscador + resolução do PDF na CAPES.

O site é estático, mas o PDF do trabalho não tem URL pública direta: ele fica
num anexo da página antiga da Sucupira, atrás de um POST JSF com sessão. Este
servidor faz esse trabalho e entrega o PDF ao navegador.

Uso:
    python3 server.py
    # http://localhost:8765

Rotas:
    /api/health          verifica se o servidor está no ar
    /api/pdf?id=&titulo= resolve o registro antigo pelo título, baixa o anexo
                         e devolve o PDF; se não houver PDF, redireciona para
                         o registro antigo (com o anexo) ou para o registro novo.

Não há dependências além da biblioteca padrão.
"""

from __future__ import annotations

import html
import http.cookiejar
import json
import os
import re
import sys
import threading
import unicodedata
import urllib.parse
import urllib.request
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

RAIZ = Path(__file__).resolve().parent
PORTA = int(os.environ.get('PORT', '8765'))

CATALOGO_ANTIGO = 'https://catalogodeteses.capes.gov.br/catalogo-teses/rest/busca'
REGISTRO_NOVO = 'https://sucupira.capes.gov.br/observatorio/detalhamento/teses-e-dissertacoes/'
USER_AGENT = 'Mozilla/5.0 (compatible; BuscadorCapes/1.0)'

_cache_links: dict[str, str] = {}
_cache_lock = threading.Lock()

_cache_pdf: dict[str, tuple[bytes, str]] = {}
_cache_pdf_ord: list[str] = []
_cache_pdf_lock = threading.Lock()


def normalizar(texto: str) -> str:
    texto = unicodedata.normalize('NFKD', texto or '')
    texto = ''.join(c for c in texto if not unicodedata.combining(c))
    return re.sub(r'\s+', ' ', texto).strip().lower()


def buscar_registro_antigo(titulo: str, ano: str = '', ies: str = '') -> str | None:
    """Devolve a URL da página antiga da Sucupira para o título, se existir."""
    chave = '|'.join((normalizar(titulo), str(ano or ''), str(ies or '')))
    if not chave.strip('|'):
        return None

    with _cache_lock:
        if chave in _cache_links:
            return _cache_links[chave]

    consultas = [f'"{titulo}"', titulo]
    for termo in consultas:
        corpo = json.dumps({
            'termo': termo,
            'filtros': [],
            'pagina': 1,
            'registrosPorPagina': 10,
        }).encode('utf-8')
        pedido = urllib.request.Request(
            CATALOGO_ANTIGO,
            data=corpo,
            headers={
                'Content-Type': 'application/json',
                'User-Agent': USER_AGENT,
                'Accept': 'application/json',
            },
        )
        try:
            with urllib.request.urlopen(pedido, timeout=30) as resposta:
                dados = json.load(resposta)
        except Exception as erro:  # noqa: BLE001 - serviço público e instável
            print(f'  catálogo antigo: {erro}', file=sys.stderr)
            continue

        candidatos = dados.get('tesesDissertacoes') or []
        exatos = [
            item for item in candidatos
            if normalizar(item.get('titulo', '')) == chave
        ]
        if not exatos:
            # Títulos antigos podem vir com pequenas diferenças de pontuação.
            exatos = [
                item for item in candidatos
                if chave in normalizar(item.get('titulo', ''))
                or normalizar(item.get('titulo', '')) in chave
            ]

        if exatos:
            if ano:
                do_ano = [item for item in exatos if str(item.get('ano')) == str(ano)]
                if do_ano:
                    exatos = do_ano
            link = (exatos[0].get('link') or '').strip()
            if link.startswith(('https://sucupira.capes.gov.br/',
                                'https://sucupira-legado.capes.gov.br/')):
                with _cache_lock:
                    _cache_links[chave] = link
                return link

    return None


def extrair_formulario(pagina: str) -> tuple[str, str, str, str] | None:
    """Lê action, ViewState, nome do comando e nome do anexo da página antiga."""
    formulario = re.search(
        r'<form[^>]+id="download"[^>]*action="([^"]+)"', pagina, re.I | re.S
    )
    viewstate = re.search(
        r'name="javax\.faces\.ViewState"[^>]*value="([^"]+)"', pagina, re.I
    )
    comando = re.search(
        r'id="(download:[^"]+)"[^>]*onclick="[^"]*mojarra\.jsfcljs', pagina, re.I
    )
    if not (formulario and viewstate and comando):
        return None

    nome_anexo = ''
    ancora = re.search(
        r'<a[^>]+id="download:[^"]+"[^>]*>(.*?)</a>', pagina, re.I | re.S
    )
    if ancora:
        nome_anexo = re.sub(r'<[^>]+>', '', ancora.group(1))
        nome_anexo = html.unescape(re.sub(r'\s+', ' ', nome_anexo)).strip()

    return (
        html.unescape(formulario.group(1)),
        html.unescape(viewstate.group(1)),
        html.unescape(comando.group(1)),
        nome_anexo,
    )


def baixar_pdf(link: str) -> tuple[bytes, str] | None:
    """Abre a página antiga, envia o formulário de download e devolve o PDF."""
    cookies = http.cookiejar.CookieJar()
    opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(cookies))

    pedido = urllib.request.Request(link, headers={'User-Agent': USER_AGENT})
    try:
        with opener.open(pedido, timeout=30) as resposta:
            final = resposta.geturl()
            pagina = resposta.read().decode('latin-1', 'ignore')
    except Exception as erro:  # noqa: BLE001
        print(f'  página antiga: {erro}', file=sys.stderr)
        return None

    formulario = extrair_formulario(pagina)
    if not formulario:
        return None

    action, viewstate, comando, nome_anexo = formulario
    action = urllib.parse.urljoin(final, action)
    if not action.startswith(('https://sucupira.capes.gov.br/',
                              'https://sucupira-legado.capes.gov.br/')):
        return None

    corpo = urllib.parse.urlencode({
        'download': 'download',
        comando: comando,
        'javax.faces.ViewState': viewstate,
    }).encode('utf-8')

    pedido = urllib.request.Request(
        action,
        data=corpo,
        headers={
            'Content-Type': 'application/x-www-form-urlencoded',
            'User-Agent': USER_AGENT,
        },
    )
    try:
        with opener.open(pedido, timeout=90) as resposta:
            tipo = (resposta.headers.get('Content-Type') or '').lower()
            if 'pdf' not in tipo:
                return None
            pdf = resposta.read()
    except Exception as erro:  # noqa: BLE001
        print(f'  download do anexo: {erro}', file=sys.stderr)
        return None

    if not pdf.startswith(b'%PDF'):
        return None

    nome = re.sub(r'[^A-Za-z0-9._-]+', '_', nome_anexo or 'trabalho.pdf')
    if not nome.lower().endswith('.pdf'):
        nome += '.pdf'
    return pdf, nome


def pagina_carregando(id_novo: str, titulo: str) -> str:
    destino = (
        REGISTRO_NOVO + urllib.parse.quote(id_novo)
        if id_novo else 'https://catalogodeteses.capes.gov.br/'
    )
    titulo_seguro = html.escape(titulo[:140])
    destino_seguro = html.escape(destino, quote=True)
    return f'''<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Buscando o PDF…</title>
<style>
  :root {{ color-scheme: light; }}
  [hidden] {{ display: none !important; }}
  body {{
    margin: 0; min-height: 100vh; display: grid; place-items: center;
    background: #f7f4ed; color: #102448;
    font-family: "Inter", -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    padding: 24px;
  }}
  main {{ max-width: 560px; text-align: center; }}
  .marca {{ width: 54px; height: 54px; margin: 0 auto 22px; display: block; }}
  h1 {{ font-size: 1.35rem; margin: 0 0 10px; letter-spacing: -.02em; }}
  p {{ color: #55617a; line-height: 1.6; margin: 0 0 18px; }}
  .obra {{ font-size: .9rem; color: #2b3b56; margin-bottom: 22px; }}
  .roda {{
    width: 28px; height: 28px; margin: 0 auto 18px;
    border: 3px solid #e4ddce; border-top-color: #a94d0c;
    border-radius: 50%; animation: girar .9s linear infinite;
  }}
  a {{ color: #a94d0c; font-weight: 600; }}
  #pdf {{
    display: block; width: 100%; height: 62vh; min-height: 420px;
    margin: 14px auto 0; border: 1px solid #e4ddce; border-radius: 12px;
    background: #fff;
  }}
  body.com-pdf {{ display: block; padding: 18px; }}
  body.com-pdf main {{ max-width: 1100px; width: 100%; margin: 0 auto; }}
  body.com-pdf .roda {{ display: none; }}
  body.com-pdf .marca {{ width: 38px; height: 38px; margin-bottom: 8px; }}
  body.com-pdf h1 {{ font-size: 1.15rem; }}
  body.com-pdf .obra {{ margin-bottom: 8px; }}
  body.com-pdf #msg {{ margin-bottom: 6px; }}
  .baixar {{
    display: inline-block; margin-top: 12px; padding: 10px 16px;
    border-radius: 9px; background: #102448; color: #fff;
    text-decoration: none; font-weight: 600;
  }}
  @keyframes girar {{ to {{ transform: rotate(360deg); }} }}
  @media (prefers-reduced-motion: reduce) {{ .roda {{ animation: none; }} }}
</style>
</head>
<body>
<main>
  <img class="marca" src="/assets/logo-512.webp" alt="">
  <div class="roda" aria-hidden="true"></div>
  <h1 id="titulo">Buscando o PDF na CAPES…</h1>
  <p class="obra">{titulo_seguro}</p>
  <p id="msg">O anexo fica no registro antigo da Sucupira. Em alguns casos a CAPES demora; esta página avisa quando terminar.</p>
  <a id="fallback" href="{destino_seguro}" hidden>Abrir o registro oficial</a>
  <iframe id="pdf" title="PDF do trabalho" hidden></iframe>
</main>
<script>
  const alvo = '/api/pdf-file' + location.search;
  const msg = document.getElementById('msg');
  const fallback = document.getElementById('fallback');
  const titulo = document.getElementById('titulo');

  fetch(alvo).then(async (r) => {{
    const tipo = r.headers.get('Content-Type') || '';
    if (!r.ok) throw new Error('HTTP ' + r.status);

    if (tipo.includes('application/pdf')) {{
      const blob = await r.blob();
      const url = URL.createObjectURL(blob);
      const disp = r.headers.get('Content-Disposition') || '';
      const achado = disp.match(/filename="([^"]+)"/);
      const nome = achado ? achado[1] : 'trabalho.pdf';

      const frame = document.getElementById('pdf');
      frame.src = url;
      frame.hidden = false;
      document.body.classList.add('com-pdf');
      document.title = 'PDF do trabalho';
      titulo.textContent = 'PDF do trabalho';

      const abrir = document.createElement('a');
      abrir.href = url;
      abrir.target = '_blank';
      abrir.rel = 'noopener';
      abrir.textContent = 'abrir em nova aba';

      const baixar = document.createElement('a');
      baixar.href = url;
      baixar.download = nome;
      baixar.textContent = 'baixar o PDF';

      msg.textContent = 'Se o visualizador não carregar, ';
      msg.append(abrir, ' ou ', baixar, '.');
      fallback.hidden = false;
      return;
    }}

    const dados = await r.json();
    if (!dados.url) throw new Error('sem destino');
    location.replace(dados.url);
  }}).catch((erro) => {{
    console.error(erro);
    msg.textContent = 'Não foi possível baixar o PDF agora. Abra o registro oficial para tentar por lá.';
    fallback.hidden = false;
  }});
</script>
</body>
</html>'''


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(RAIZ), **kwargs)

    def log_message(self, formato, *args):
        # Mantém o terminal limpo: só erros e as rotas da API.
        if self.path.startswith('/api/'):
            super().log_message(formato, *args)

    def enviar_json(self, dados, status=200):
        corpo = json.dumps(dados).encode('utf-8')
        self.send_response(status)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Content-Length', str(len(corpo)))
        self.send_header('Cache-Control', 'no-store')
        self.end_headers()
        self.wfile.write(corpo)

    def servir_pdf(self, pdf: bytes, nome: str):
        self.send_response(200)
        self.send_header('Content-Type', 'application/pdf')
        self.send_header('Content-Length', str(len(pdf)))
        self.send_header('Content-Disposition', f'inline; filename="{nome}"')
        self.send_header('Cache-Control', 'private, max-age=300')
        self.end_headers()
        self.wfile.write(pdf)

    def redirecionar(self, url):
        self.send_response(302)
        self.send_header('Location', url)
        self.send_header('Cache-Control', 'no-store')
        self.end_headers()

    def do_GET(self):
        partes = urllib.parse.urlsplit(self.path)
        rota = partes.path

        if rota == '/api/health':
            self.enviar_json({'ok': True})
            return

        if rota == '/api/pdf':
            parametros = urllib.parse.parse_qs(partes.query)
            titulo = (parametros.get('titulo') or [''])[0].strip()
            id_novo = (parametros.get('id') or [''])[0].strip()
            corpo = pagina_carregando(id_novo, titulo).encode('utf-8')
            self.send_response(200)
            self.send_header('Content-Type', 'text/html; charset=utf-8')
            self.send_header('Content-Length', str(len(corpo)))
            self.send_header('Cache-Control', 'no-store')
            self.end_headers()
            self.wfile.write(corpo)
            return

        if rota == '/api/pdf-file':
            parametros = urllib.parse.parse_qs(partes.query)
            titulo = (parametros.get('titulo') or [''])[0].strip()
            ano = (parametros.get('ano') or [''])[0].strip()
            ies = (parametros.get('ies') or [''])[0].strip()
            id_novo = (parametros.get('id') or [''])[0].strip()
            destino = (
                REGISTRO_NOVO + urllib.parse.quote(id_novo)
                if id_novo else 'https://catalogodeteses.capes.gov.br/'
            )

            if not titulo:
                self.enviar_json({'url': destino})
                return

            chave_pdf = '|'.join((normalizar(titulo), str(ano), str(ies)))
            with _cache_pdf_lock:
                if chave_pdf in _cache_pdf:
                    pdf, nome = _cache_pdf[chave_pdf]
                    self.servir_pdf(pdf, nome)
                    return

            print(f'  PDF: {titulo[:70]}', flush=True)
            link = buscar_registro_antigo(titulo, ano, ies)
            if not link:
                self.enviar_json({'url': destino})
                return

            resultado = baixar_pdf(link)
            if not resultado:
                # A página antiga ainda serve: nela está o anexo.
                self.enviar_json({'url': link})
                return

            pdf, nome = resultado
            with _cache_pdf_lock:
                _cache_pdf[chave_pdf] = (pdf, nome)
                _cache_pdf_ord.append(chave_pdf)
                while len(_cache_pdf_ord) > 3:
                    antigo = _cache_pdf_ord.pop(0)
                    _cache_pdf.pop(antigo, None)
            self.servir_pdf(pdf, nome)
            return

        super().do_GET()


def main():
    servidor = ThreadingHTTPServer(('', PORTA), Handler)
    print(f'Buscador CAPES em http://localhost:{PORTA}')
    print('  PDF: /api/pdf  ·  Ctrl+C para parar')
    try:
        servidor.serve_forever()
    except KeyboardInterrupt:
        print('\nAté logo.')
        servidor.server_close()


if __name__ == '__main__':
    main()
