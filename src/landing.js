import QRCode from 'qrcode';
import { config } from './config.js';

/** Pretty-print a +1XXXXXXXXXX E.164 US number as +1 (555) 012-3456. */
function formatNumber(e164) {
  const m = /^\+1(\d{3})(\d{3})(\d{4})$/.exec(e164 || '');
  if (m) return `+1 (${m[1]}) ${m[2]}-${m[3]}`;
  return e164 || '';
}

const EXAMPLES = [
  'What’s bitcoin at right now?',
  'What’s trending today?',
  'Any interesting prediction markets on the election?',
  'If you were me, would you buy Tesla here?',
];

let cached = null;

/** Build the public landing page (cached after first render). */
export async function landingPage() {
  if (cached) return cached;

  const number = config.twilio.phoneNumber || '';
  const display = formatNumber(number) || 'Number coming soon';
  const telHref = number ? `tel:${number}` : '#';

  // QR encodes the dial action, so a phone camera offers "Call <number>".
  let qrSvg = '';
  if (number) {
    qrSvg = await QRCode.toString(`tel:${number}`, {
      type: 'svg',
      margin: 1,
      color: { dark: '#08070c', light: '#ffffff' },
    });
    // size the inline SVG via CSS rather than fixed attributes
    qrSvg = qrSvg.replace('<svg ', '<svg width="100%" height="100%" ');
  }

  cached = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Call your Clanker — the robot banker you can phone</title>
<meta name="description" content="Phone a deadpan AI robo-advisor. Ask for prices, trending tokens, and prediction-market odds, and get banker-style recommendations — by voice." />
<style>
  :root {
    --bg:#08070c; --panel:#120e1e; --purple:#a78bfa; --purple-deep:#7D00FF;
    --text:#f5f3ff; --sub:#9d9aa8; --green:#16c784;
    --font:-apple-system,BlinkMacSystemFont,'SF Pro Display','Segoe UI',Roboto,sans-serif;
    --mono:'SF Mono',ui-monospace,Menlo,monospace;
  }
  * { margin:0; padding:0; box-sizing:border-box; }
  body {
    background:var(--bg); color:var(--text); font-family:var(--font);
    min-height:100vh; display:flex; align-items:center; justify-content:center;
    padding:32px; overflow-x:hidden;
  }
  .glow { position:fixed; width:1100px; height:1100px; top:-340px; left:50%;
    transform:translateX(-50%);
    background:radial-gradient(circle,rgba(139,92,246,0.18) 0%,rgba(139,92,246,0) 60%);
    pointer-events:none; }
  .wrap { position:relative; max-width:1040px; width:100%;
    display:grid; grid-template-columns:1.25fr 1fr; gap:56px; align-items:center; }
  @media (max-width:820px){ .wrap{ grid-template-columns:1fr; gap:40px; text-align:center; } .qrcard{ margin:0 auto; } .examples{ text-align:left; } }
  .bot { font-size:30px; margin-bottom:22px; display:inline-flex; align-items:center; gap:12px;
    color:var(--purple); font-weight:700; letter-spacing:1px; }
  .bot svg { width:38px; height:38px; }
  h1 { font-size:54px; font-weight:800; letter-spacing:-1.5px; line-height:1.05; }
  h1 .accent { color:var(--purple); }
  .tagline { margin-top:18px; font-size:20px; color:var(--sub); line-height:1.5; max-width:480px; }
  .call {
    display:inline-flex; align-items:center; gap:14px; margin-top:34px;
    background:var(--purple-deep); color:#fff; text-decoration:none;
    font-family:var(--mono); font-size:30px; font-weight:600; letter-spacing:0.5px;
    padding:18px 30px; border-radius:16px;
    box-shadow:0 18px 50px rgba(125,0,255,0.4); transition:transform .15s ease;
  }
  .call:hover { transform:translateY(-2px); }
  .call svg { width:26px; height:26px; }
  .hint { margin-top:14px; font-size:14px; color:var(--sub); letter-spacing:1px; text-transform:uppercase; }
  .examples { margin-top:32px; display:flex; flex-direction:column; gap:10px; }
  .examples .lbl { font-size:13px; font-weight:700; color:var(--purple); letter-spacing:3px; text-transform:uppercase; margin-bottom:4px; }
  .examples .q { font-size:17px; color:var(--text); opacity:.9; }
  .examples .q::before { content:"“"; color:var(--sub); } .examples .q::after { content:"”"; color:var(--sub); }
  .qrcard { background:#fff; border-radius:24px; padding:26px; width:300px;
    box-shadow:0 30px 80px rgba(0,0,0,.55), 0 0 60px rgba(139,92,246,.18); }
  .qrcard .qr { width:248px; height:248px; }
  .qrcard .cap { margin-top:14px; text-align:center; color:#08070c; font-weight:700; font-size:15px; }
  .qrcard .cap span { display:block; color:#6b6878; font-weight:500; font-size:13px; margin-top:2px; }
  .badge { display:inline-block; margin-top:30px; padding:8px 16px; border-radius:999px;
    border:1px solid rgba(22,199,132,.4); background:rgba(22,199,132,.1);
    color:var(--green); font-size:13px; font-weight:700; letter-spacing:.5px; }
  footer { position:fixed; bottom:18px; left:0; right:0; text-align:center;
    font-size:12px; color:#55525e; padding:0 24px; }
</style>
</head>
<body>
  <div class="glow"></div>
  <div class="wrap">
    <div class="intro">
      <div class="bot">
        <svg viewBox="0 0 100 100" fill="none">
          <rect x="22" y="30" width="56" height="44" rx="12" stroke="currentColor" stroke-width="6"/>
          <circle cx="40" cy="52" r="6" fill="currentColor"/>
          <circle cx="60" cy="52" r="6" fill="currentColor"/>
          <path d="M50 18 V30" stroke="currentColor" stroke-width="6" stroke-linecap="round"/>
          <circle cx="50" cy="14" r="5" fill="currentColor"/>
          <path d="M16 48 V58 M84 48 V58" stroke="currentColor" stroke-width="6" stroke-linecap="round"/>
        </svg>
        CALL YOUR CLANKER
      </div>
      <h1>The robot banker<br/>you can <span class="accent">phone</span>.</h1>
      <div class="tagline">Dial the number. Ask a deadpan AI robo-advisor for live prices, trending tokens, and prediction-market odds &mdash; and get banker-style recommendations, out loud.</div>
      <a class="call" href="${telHref}">
        <svg viewBox="0 0 24 24" fill="currentColor"><path d="M6.6 10.8c1.4 2.8 3.8 5.2 6.6 6.6l2.2-2.2c.3-.3.7-.4 1-.2 1.1.4 2.3.6 3.6.6.6 0 1 .4 1 1V20c0 .6-.4 1-1 1C10.6 21 3 13.4 3 4c0-.6.4-1 1-1h3.5c.6 0 1 .4 1 1 0 1.2.2 2.4.6 3.6.1.4 0 .8-.3 1l-2.2 2.2z"/></svg>
        ${display}
      </a>
      <div class="hint">Tap to call &middot; or scan the code &rarr;</div>
      <div class="examples">
        <div class="lbl">Try asking</div>
        ${EXAMPLES.map((q) => `<div class="q">${q}</div>`).join('\n        ')}
      </div>
      <div class="badge">● READ-ONLY DEMO — Clanker advises, never moves funds</div>
    </div>
    <div class="qrcard">
      <div class="qr">${qrSvg || '<div style="color:#08070c;text-align:center;padding:90px 0;font-weight:700;">QR pending<br/>number setup</div>'}</div>
      <div class="cap">Scan to call<span>${display}</span></div>
    </div>
  </div>
  <footer>Powered by Nova agent tools, Claude, Twilio &amp; ElevenLabs. Informational only — not financial advice.</footer>
</body>
</html>`;
  return cached;
}
