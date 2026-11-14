/** The sign-in pages' own rules; /assets/signin.css serves @land/tokens followed by these. */
export const SIGNIN_CSS = `
* { box-sizing: border-box; }
[hidden] { display: none !important; }
html, body { margin: 0; background: var(--bg); }
body { color: var(--t1); font: 14px/1.45 'Geist', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; -webkit-font-smoothing: antialiased; }
.frame { min-height: 100vh; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 18px; padding: 32px 16px; }
.card { width: 100%; max-width: 380px; background: var(--sf); border: 1px solid var(--hair); border-radius: 16px; padding: 26px 24px 22px; }
h1 { font-size: 20px; font-weight: 600; letter-spacing: -.01em; margin: 0 0 4px; }
.sub { color: var(--t2); margin: 0 0 18px; font-size: 13px; }
.stack { display: flex; flex-direction: column; gap: 12px; }
label { display: flex; flex-direction: column; gap: 6px; font-size: 12px; font-weight: 600; color: var(--t2); }
input { height: 36px; padding: 0 12px; border-radius: 10px; border: 1px solid var(--bd); background: var(--bg); color: var(--t1); font: inherit; font-size: 14px; font-weight: 400; }
input:focus { outline: 2px solid var(--ac); outline-offset: 1px; border-color: transparent; }
button { height: 36px; border-radius: 999px; border: 1px solid transparent; font: inherit; font-weight: 600; font-size: 13px; cursor: pointer; padding: 0 16px; }
.primary { background: var(--ac2); color: var(--on-ac); margin-top: 4px; }
.primary:hover { background: var(--ac2-hover); }
.ghost { background: transparent; color: var(--t2); border-color: var(--bd); }
.row { display: flex; gap: 8px; margin-top: 4px; }
.row .primary { margin-top: 0; }
.alert { background: var(--rddim); border: 1px solid var(--rdbd); color: var(--rd); border-radius: 10px; padding: 8px 12px; font-size: 13px; margin: 0 0 14px; }
.hint { color: var(--t3); font-size: 12px; margin: -4px 0 0; }
.aside { margin: 14px 0 0; font-size: 12px; text-align: center; }
a { color: var(--t2); }
a:hover { color: var(--t1); }
.foot { color: var(--t3); font-size: 12px; margin: 0; }
.qr { display: grid; place-items: center; margin: 4px 0 10px; }
.qr img { border-radius: 10px; border: 1px solid var(--hair); background: #fff; padding: 6px; }
.center { text-align: center; margin: 0 0 6px; }
.key { margin: 0 0 18px; padding: 8px 10px; border: 1px solid var(--bd); border-radius: 10px; background: var(--bg); text-align: center; }
code { font-family: 'Geist Mono', ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; color: var(--t1); letter-spacing: .04em; }
.key code { word-break: keep-all; }
.link { background: none; border: 0; height: auto; padding: 0; color: var(--t2); font-weight: 400; font-size: 12px; text-decoration: underline; }
.link:hover { color: var(--t1); }
.or { display: flex; align-items: center; gap: 10px; color: var(--t3); font-size: 12px; margin: 2px 0; }
.or::before, .or::after { content: ''; flex: 1; height: 1px; background: var(--hair); }
.passkey { margin-top: 14px; }
[data-status]:empty { display: none; }
.passkey .ghost { width: 100%; }
.passkey .primary { margin-top: 0; }
.note { background: var(--acdim); border: 1px solid var(--acbd); color: var(--t1); border-radius: 10px; padding: 8px 12px; font-size: 13px; margin: 0 0 14px; }
.ok { background: var(--gndim); border: 1px solid var(--gnbd); color: var(--t1); border-radius: 10px; padding: 8px 12px; font-size: 13px; margin: 0 0 14px; }
.card.wide { max-width: 560px; }
.section { border-top: 1px solid var(--hair); margin-top: 18px; padding-top: 16px; }
.section h2 { font-size: 14px; font-weight: 600; margin: 0 0 10px; }
.items { list-style: none; margin: 0 0 10px; padding: 0; display: flex; flex-direction: column; gap: 8px; }
.items li { display: flex; align-items: center; justify-content: space-between; gap: 12px; border: 1px solid var(--hair); border-radius: 10px; padding: 8px 10px; }
.items .what { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
.items .meta { color: var(--t3); font-size: 12px; }
.items form { margin: 0; }
.items button, .actions button { height: 30px; padding: 0 12px; font-size: 12px; }
.actions { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
.actions form { margin: 0; }
.tag { font-size: 11px; color: var(--t2); border: 1px solid var(--bd); border-radius: 999px; padding: 1px 8px; white-space: nowrap; }
.codes { display: grid; grid-template-columns: repeat(2, 1fr); gap: 8px; margin: 0 0 14px; padding: 12px; border: 1px solid var(--bd); border-radius: 10px; background: var(--bg); text-align: center; }
.top { display: flex; justify-content: space-between; align-items: baseline; gap: 12px; }
.check { flex-direction: row; align-items: center; gap: 8px; font-weight: 400; color: var(--t1); font-size: 13px; }
.check input { height: auto; }
.pad { margin-top: 10px; }
details summary { cursor: pointer; }
`;
