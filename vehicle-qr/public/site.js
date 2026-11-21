// Shared header and footer for the website pages.
(() => {
  const mark = '<span class="mark" aria-hidden="true"></span>';
  const header = document.createElement('header');
  header.className = 'site-header';
  header.innerHTML = `<div class="bar">
    <a class="logo" href="/">${mark}VehicleAssist</a>
    <nav class="nav" aria-label="Main">
      <a href="/#how" data-i="nav.how"></a>
      <a href="/#features" data-i="nav.features"></a>
      <a href="/provider" data-i="nav.providers"></a>
      <a href="/#faq" data-i="nav.faq"></a>
    </nav>
    <div class="hdr-actions"><select class="lang-sel" id="langSel" data-al="lang.label"></select><span id="hdrActions" class="hdr-actions" style="gap:8px"></span></div>
  </div>`;
  document.body.prepend(header);

  const footer = document.createElement('footer');
  footer.className = 'site-footer';
  footer.innerHTML = `<div class="inner">
    <div><a class="logo" href="/">${mark}VehicleAssist</a>
      <p data-i="ft.tag"></p></div>
    <div><a href="/owner" data-i="ft.owner"></a><a href="/provider" data-i="ft.provider"></a><a href="/contact" data-i="ft.contact"></a></div>
    <div><a href="/#how" data-i="ft.how"></a><a href="/#faq" data-i="ft.faq"></a><a href="/privacy" data-i="ft.privacy"></a><a href="/remove" data-i="ft.remove"></a><small data-i="ft.small"></small></div>
  </div>`;
  document.body.append(footer);

  const box = document.getElementById('hdrActions');
  const link = (href, key, cls) => { const a = document.createElement('a'); a.href = href; a.setAttribute('data-i', key); a.className = cls; return a; };
  fetch('/api/me').then((r) => (r.ok ? r.json() : null)).catch(() => null).then((u) => {
    if (u) {
      box.append(link(u.next, 'btn.dashboard', 'btn sm'));
      const out = document.createElement('button');
      out.className = 'btn ghost sm'; out.setAttribute('data-i', 'btn.logout');
      out.onclick = () => fetch('/api/logout', { method: 'POST' }).then(() => { location.href = '/'; });
      box.append(out);
    } else {
      box.append(link('/owner', 'btn.login', 'btn ghost sm in'), link('/owner', 'btn.create', 'btn sm create'));
    }
    if (window.I18N) I18N.apply(box);
  });

  const sel = document.getElementById('langSel');
  if (window.I18N && sel) {
    I18N.LANGS.forEach(([c, n]) => { const o = document.createElement('option'); o.value = c; o.textContent = n; sel.append(o); });
    sel.value = I18N.getLang();
    sel.onchange = () => {
      I18N.setLang(sel.value);
      fetch('/api/lang', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ lang: sel.value }) }).catch(() => {});
    };
    window.addEventListener('langchange', () => { sel.value = I18N.getLang(); });
    I18N.apply(document);
  }
})();
