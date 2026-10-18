#!/usr/bin/env python3
"""Gera assets/ies.js a partir da API pública do Observatório da CAPES.

O arquivo reúne:
  - o cadastro de instituições (sigla, UF, região, dependência);
  - os grupos de IES que têm programa nas áreas de Educação/Ensino;
  - os ids dos programas de modalidade profissional.

Uso (na raiz do projeto):
    python3 tools/build_ies.py

Não há dependências além da biblioteca padrão. O script faz algumas centenas
de requisições; se a API oscilar, ele tenta novamente.
"""

import json
import sys
import time
import urllib.parse
import urllib.request
from collections import defaultdict
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

BASE = 'https://apigw-proxy.capes.gov.br/observatorio'
IES_URL = BASE + '/data/online/ies'
PPG_URL = BASE + '/data/online/ppg'
SAIDA = Path(__file__).resolve().parent.parent / 'assets' / 'ies.js'

AREAS = ('EDUCAÇÃO', 'ENSINO')
DEPENDENCIAS = {
    'Pública Federal': 'FEDERAL',
    'Pública Estadual': 'ESTADUAL',
    'Pública Municipal': 'MUNICIPAL',
    'Particular': 'PRIVADA',
    'Estrangeira': 'ESTRANGEIRA',
}


def buscar(url, tentativas=4):
    for tentativa in range(tentativas):
        try:
            with urllib.request.urlopen(url, timeout=45) as resposta:
                return json.load(resposta)
        except Exception as erro:  # noqa: BLE001 - rede pública e instável
            if tentativa == tentativas - 1:
                print(f'  falha: {erro}', file=sys.stderr)
                return None
            time.sleep(0.6 * (tentativa + 1))
    return None


def paginar(url, tamanho=50):
    """Percorre todas as páginas de um endpoint paginado."""
    itens = []
    pagina = 0
    while True:
        consulta = urllib.parse.urlencode({'page': pagina, 'size': tamanho})
        dados = buscar(url + '?' + consulta)
        if not dados:
            break
        conteudo = dados.get('content') or []
        itens.extend(conteudo)
        if len(conteudo) < tamanho:
            break
        pagina += 1
    return itens


def main():
    print('Lendo instituições...')
    ies = paginar(IES_URL)
    if not ies:
        sys.exit('Não foi possível ler o cadastro de IES.')

    por_id = {}
    por_sigla = {}
    for item in ies:
        sigla = (item.get('sigla') or '').strip()
        if not sigla:
            continue
        uf = (item.get('uf') or '').strip()
        nome = (item.get('nome') or '').strip()
        regiao = (item.get('regiao') or '').strip()
        categoria = (item.get('categoriaAdministrativa') or '').strip()
        id_ies = item.get('idIes')
        if id_ies is not None:
            por_id[str(id_ies)] = [sigla, uf, nome, regiao, categoria]
        por_sigla.setdefault(sigla, [uf, str(id_ies or ''), nome, regiao, categoria])

    print(f'  {len(por_sigla)} instituições')

    print('Lendo programas (isso pode levar um minuto)...')
    # O endpoint /ppg não aplica filtro de área; baixamos o catálogo e filtramos aqui.
    programas = paginar(PPG_URL)
    if not programas:
        sys.exit('Não foi possível ler o catálogo de programas.')

    edu = [
        p for p in programas
        if (p.get('nomeAreaAvaliacao') or '').strip().upper() in AREAS
    ]
    print(f'  {len(edu)} programas em Educação/Ensino')

    grupos = {
        'uf': defaultdict(set),
        'regiao': defaultdict(set),
        'dependencia': defaultdict(set),
    }

    for programa in edu:
        sigla = (programa.get('siglaIes') or '').strip()
        dados = por_sigla.get(sigla)
        if not dados or not dados[1]:
            continue
        id_ies = str(dados[1])
        uf, _, _, regiao, categoria = dados
        if uf:
            grupos['uf'][uf].add(id_ies)
        if regiao:
            grupos['regiao'][regiao.upper()].add(id_ies)
        dependencia = DEPENDENCIAS.get(categoria)
        if dependencia:
            grupos['dependencia'][dependencia].add(id_ies)

    profissionais = [p for p in edu if (p.get('modalidade') or '').upper() == 'PROFISSIONAL']
    mestrado = sorted({
        int(p['idPrograma']) for p in profissionais
        if 'MESTRADO PROFISSIONAL' in (p.get('grau') or '').upper()
    })
    doutorado = sorted({
        int(p['idPrograma']) for p in profissionais
        if 'DOUTORADO PROFISSIONAL' in (p.get('grau') or '').upper()
    })

    dados = {
        'byId': por_id,
        'bySigla': por_sigla,
        'grupos': {
            chave: {valor: sorted(ids) for valor, ids in sorted(mapa.items())}
            for chave, mapa in grupos.items()
        },
        'programasProfissionais': {'mestrado': mestrado, 'doutorado': doutorado},
    }

    cabecalho = '''/* Instituições de ensino superior e programas da pós-graduação brasileira.
   Gerado a partir da API oficial do Observatório da CAPES
   (cadastro de IES e programas das áreas de avaliação Educação e Ensino).
   byId:   [sigla, UF, nome, região, categoria administrativa]
   bySigla:[UF, id, nome, região, categoria administrativa]
   grupos: ids internos das IES que têm programa em Educação/Ensino,
           agrupados por UF, região e dependência administrativa.
   programasProfissionais: ids internos dos programas de modalidade profissional. */
window.CAPES_IES = %s;
'''

    SAIDA.write_text(
        cabecalho % json.dumps(dados, ensure_ascii=False, separators=(',', ':'), sort_keys=True),
        encoding='utf-8',
    )
    print(f'Gravado {SAIDA} ({SAIDA.stat().st_size // 1024} KB)')


if __name__ == '__main__':
    main()
