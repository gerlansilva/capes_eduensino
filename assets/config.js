/* URL do servidor Python que resolve o PDF (server.py).
   - Desenvolvimento local ou Cloudflare Tunnel: deixe vazio (mesmo domínio).
   - Cloudflare Pages: aponte para o serviço Python publicado no Render/Fly, por exemplo:
       window.CAPES_PDF_API = 'https://capes-eduensino.onrender.com';
   O site continua funcionando sem essa URL; apenas o botão de PDF fica oculto. */
window.CAPES_PDF_API = '';
