/* Test the landing's language routing the honest way: override the language at
 * the BROWSER level (Emulation.setUserAgentOverride carries acceptLanguage,
 * which is what drives navigator.languages), then navigate and watch what the
 * page actually paints. Overriding navigator inside the page does not survive a
 * reload, which is why the first attempt at this test lied. */

const PORT = process.env.LEX_DEV_PORT || 9222;
const BASE = `http://127.0.0.1:${PORT}`;
const SITE = 'http://127.0.0.1:4173/';

const CASES = [
  { name: 'русский',    accept: 'ru-RU,ru;q=0.9',  expect: '/ru/' },
  { name: 'румынский',  accept: 'ro-MD,ro;q=0.9',  expect: '/ro/' },
  { name: 'молдавский', accept: 'mo,ro;q=0.9',     expect: '/ro/' },
  { name: 'английский', accept: 'en-US,en;q=0.9',  expect: '/' },
  { name: 'немецкий',   accept: 'de-DE,de;q=0.9',  expect: '/' },
  { name: 'без языка',  accept: '',                expect: '/' },
];

const targets = await (await fetch(`${BASE}/json/list`)).json();
const page = targets.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
if (!page) throw new Error('no page target on ' + BASE);

const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((r) => { ws.onopen = r; });

let id = 0;
const pending = new Map();
ws.onmessage = (ev) => {
  const m = JSON.parse(typeof ev.data === 'string' ? ev.data : ev.data.toString());
  if (m.id && pending.has(m.id)) {
    const { resolve, reject } = pending.get(m.id);
    pending.delete(m.id);
    m.error ? reject(new Error(m.error.message)) : resolve(m.result);
  }
};
const send = (method, params = {}) =>
  new Promise((resolve, reject) => {
    const n = ++id;
    pending.set(n, { resolve, reject });
    ws.send(JSON.stringify({ id: n, method, params }));
  });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

await send('Page.enable');
await send('Runtime.enable');

const ua = (await send('Runtime.evaluate', { expression: 'navigator.userAgent', returnByValue: true }))
  .result.value;

console.log('язык браузера          ->  адрес     заголовок / кнопки');
console.log('─'.repeat(78));

let failures = 0;
for (const c of CASES) {
  await send('Emulation.setUserAgentOverride', { userAgent: ua, acceptLanguage: c.accept });
  // Clear the manual-choice key so each case starts like a first-time visitor.
  await send('Page.navigate', { url: SITE });
  await sleep(900);
  await send('Runtime.evaluate', { expression: "try{localStorage.removeItem('lexLangPick')}catch(e){}" });
  await send('Page.navigate', { url: SITE });
  await sleep(1400);

  const out = (await send('Runtime.evaluate', {
    expression: `JSON.stringify({
      p: location.pathname,
      t: document.title.slice(0, 46),
      langs: navigator.languages,
      opts: [...document.querySelectorAll('.lang-opt')].map(e => e.textContent)
    })`,
    returnByValue: true,
  })).result.value;

  const r = JSON.parse(out);
  const ok = r.p === c.expect;
  if (!ok) failures++;
  console.log(
    `${(ok ? '✓' : '✗')} ${c.name.padEnd(20)} -> ${r.p.padEnd(8)}  ${r.t}  [${r.opts.join(',')}]`
  );
}

console.log('─'.repeat(78));
console.log(failures ? `ПРОВАЛЕНО: ${failures}` : 'все случаи прошли');

await send('Emulation.setUserAgentOverride', { userAgent: ua, acceptLanguage: '' });
ws.close();
process.exit(failures ? 1 : 0);
