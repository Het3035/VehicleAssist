// "Your data" card shown on the owner and provider dashboards: download a copy, or delete the account.
(() => {
  const host = document.getElementById('accountCard');
  if (!host) return;
  const el = (t, p = {}, ...k) => { const e = Object.assign(document.createElement(t), p); k.flat().forEach((x) => e.append(x)); return e; };
  const field = 'width:100%;padding:12px 13px;border:1.5px solid #b9beb6;border-radius:8px;font:inherit;margin-top:6px';

  const T = (k, v) => I18N.t(k, v);
  const body = el('div');
  const h = el('h2', { style: 'margin-bottom:6px' });
  host.append(h, body);
  let view = 'home';
  const BTN = 'width:100%;height:40px;display:flex;align-items:center;justify-content:center;box-sizing:border-box;padding:0 14px;';
  function home() {
    view = 'home';
    h.textContent = T('ac.h');
    const dl = el('a', { className: 'btn ghost', href: '/api/account/export.pdf', download: 'my-vehicleassist-data.pdf', textContent: T('ac.dl'), style: BTN });
    const del = el('button', { className: 'btn danger', textContent: T('ac.del'), style: BTN });
    del.onclick = confirmDelete;
    body.replaceChildren(
      el('p', { className: 'meta', style: 'margin-top:0', textContent: T('ac.p') }),
      el('div', { style: 'display:grid;gap:8px;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));margin-top:12px' }, dl, del),
      el('a', { className: 'meta', href: '/privacy', textContent: T('ac.priv'), style: 'display:inline-block;margin-top:14px' }));
  }

  function confirmDelete() {
    view = 'confirm';
    const pw = el('input', { type: 'password', autocomplete: 'current-password', ariaLabel: T('ac.pw'), placeholder: T('ac.pw'), style: field });
    const go = el('button', { className: 'btn danger', textContent: T('ac.go'), style: BTN });
    const no = el('button', { className: 'btn ghost', textContent: T('ac.keep'), style: BTN });
    const out = el('div');
    no.onclick = home;
    go.onclick = async () => {
      go.disabled = true;
      const r = await fetch('/api/account', { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: pw.value }) });
      const j = await r.json().catch(() => ({}));
      if (r.ok) { location.href = '/?deleted=1'; return; }
      out.replaceChildren(el('div', { className: 'msg err', textContent: I18N.tErr(j.error) }));
      go.disabled = false;
    };
    body.replaceChildren(
      el('p', { style: 'margin-top:0;font-weight:600', textContent: T('ac.sure') }),
      el('p', { className: 'meta', textContent: T('ac.sure2') }),
      pw, el('div', { style: 'display:grid;gap:8px;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));margin-top:12px' }, go, no), out);
    pw.focus();
  }
  window.addEventListener('langchange', () => { if (view === 'home') home(); else { const v = body.querySelector('input'); const val = v ? v.value : ''; confirmDelete(); body.querySelector('input').value = val; } });
  home();
})();
