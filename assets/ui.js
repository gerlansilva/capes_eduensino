/* Painel de filtros: aberto no desktop, recolhido no celular.
   Ajuste apenas de interface — não interfere na busca nem nos filtros. */
(function () {
  var painel = document.getElementById('filtros-painel');
  if (!painel || !window.matchMedia) return;

  var desktop = window.matchMedia('(min-width: 981px)');

  function sincronizar() {
    painel.open = desktop.matches;
  }

  sincronizar();

  if (desktop.addEventListener) desktop.addEventListener('change', sincronizar);
  else if (desktop.addListener) desktop.addListener(sincronizar);
})();
