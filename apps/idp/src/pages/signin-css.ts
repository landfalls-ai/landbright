/** The sign-in pages' own rules; /assets/signin.css serves @land/tokens followed by these. No script anywhere. */
export const SIGNIN_CSS = `
* { box-sizing: border-box; }
html, body { margin: 0; background: var(--bg); }
body { color: var(--t1); font: 14px/1.45 'Geist', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; -webkit-font-smoothing: antialiased; }
.frame { min-height: 100vh; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 18px; padding: 32px 16px; }
.brand { display: flex; align-items: center; gap: 10px; font-weight: 600; font-size: 14px; }
.mark { display: grid; place-items: center; width: 34px; height: 34px; border-radius: 9px; border: 1px solid var(--acbd); background: var(--ac2); color: var(--on-ac); font-size: 12px; font-weight: 700; letter-spacing: .02em; }
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
`;
