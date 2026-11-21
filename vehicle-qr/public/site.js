// Shared header and footer for the website pages.
(() => {
  const mark = '<span class="mark" aria-hidden="true"></span>';
  const header = document.createElement('header');
  header.className = 'site-header';
  header.innerHTML = `<div class="bar">
    <a class="logo" href="/">${mark}VehicleAssist</a>
    <nav class="nav" aria-label="Main">
      <a href="/#how">How it works</a>
      <a href="/#features">Features</a>
      <a href="/provider">For service providers</a>
      <a href="/#faq">Questions</a>
    </nav>
    <div class="hdr-actions" id="hdrActions"></div>
  </div>`;
  document.body.prepend(header);

  const footer = document.createElement('footer');
  footer.className = 'site-footer';
  footer.innerHTML = `<div class="inner">
    <div><a class="logo" href="/">${mark}VehicleAssist</a>
      <p>Reach a vehicle owner without ever seeing their phone number.</p></div>
    <div><a href="/owner">Owner login</a><a href="/provider">Service provider login</a><a href="/contact">Contact an owner</a></div>
    <div><a href="/#how">How it works</a><a href="/#faq">Questions</a><small>No ads. No tracking. Your data stays in your own database.</small></div>
  </div>`;
  document.body.append(footer);

  const box = document.getElementById('hdrActions');
  const link = (href, text, cls) => { const a = document.createElement('a'); a.href = href; a.textContent = text; a.className = cls; return a; };
  fetch('/api/me').then((r) => (r.ok ? r.json() : null)).catch(() => null).then((u) => {
    if (u) {
      box.append(link(u.next, 'Dashboard', 'btn sm'));
      const out = document.createElement('button');
      out.className = 'btn ghost sm'; out.textContent = 'Log out';
      out.onclick = () => fetch('/api/logout', { method: 'POST' }).then(() => { location.href = '/'; });
      box.append(out);
    } else {
      box.append(link('/owner', 'Log in', 'btn ghost sm'), link('/owner', 'Create account', 'btn sm'));
    }
  });
})();
