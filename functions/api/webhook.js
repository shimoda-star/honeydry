// Cloudflare Pages Function: Stripe Webhook
// POST /api/webhook
// 依存パッケージなし。Web Crypto で署名検証する。

const OPT_NAME = {
  shiki: '敷布団',
  dani: '防ダニ加工',
  mofu: '毛布のついで洗い',
  hokan: '保管サービス',
};

function esc(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function formatYen(n) {
  return Number(n).toLocaleString('ja-JP') + ' 円';
}

// ===== Stripe Webhook 署名検証 (Web Crypto) =====
async function verifyStripeSignature(payload, sigHeader, secret, toleranceSec = 300) {
  if (!sigHeader) throw new Error('no signature');
  const parts = Object.fromEntries(
    sigHeader.split(',').map((kv) => {
      const i = kv.indexOf('=');
      return [kv.slice(0, i), kv.slice(i + 1)];
    })
  );
  const timestamp = parts.t;
  const v1 = parts.v1;
  if (!timestamp || !v1) throw new Error('malformed signature');

  const signedPayload = `${timestamp}.${payload}`;
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    enc.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(signedPayload));
  const expected = Array.from(new Uint8Array(sig))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');

  // 定数時間比較
  if (expected.length !== v1.length) throw new Error('signature mismatch');
  let diff = 0;
  for (let i = 0; i < expected.length; i++) {
    diff |= expected.charCodeAt(i) ^ v1.charCodeAt(i);
  }
  if (diff !== 0) throw new Error('signature mismatch');

  const age = Math.floor(Date.now() / 1000) - Number(timestamp);
  if (age > toleranceSec) throw new Error('timestamp out of tolerance');
}

async function sendEmail(env, { to, subject, html, replyTo }) {
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.RESEND_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: env.FROM_EMAIL,
      to: Array.isArray(to) ? to : [to],
      subject,
      html,
      reply_to: replyTo,
    }),
  });
  if (!res.ok) {
    const t = await res.text();
    console.error('Resend error:', res.status, t);
    throw new Error(`resend failed: ${res.status}`);
  }
}

function buildAdminEmail(session) {
  const m = session.metadata || {};
  const amount = session.amount_total;
  const email = session.customer_email || session.customer_details?.email || '';

  let optLines = '';
  for (const k of ['shiki', 'dani', 'mofu', 'hokan']) {
    const q = Number(m[`opt_${k}`] || 0);
    if (q > 0) optLines += `<li>${OPT_NAME[k]} × ${q}</li>`;
  }

  return `
  <div style="font-family:sans-serif;line-height:1.8;color:#333;max-width:600px">
    <h2 style="color:#00a8cc;border-bottom:2px solid #00a8cc;padding-bottom:8px">
      【Honey Dry】新規ご予約・決済完了
    </h2>
    <p>以下の内容でご予約・お支払いが完了しました。<br>
    <strong style="color:#ff7043">クロネコヤマトの集荷手配をお願いします。</strong></p>

    <h3>■ 集荷・受取</h3>
    <table style="border-collapse:collapse;width:100%">
      <tr><td style="padding:6px;background:#f0fafd;width:140px"><b>集荷希望日</b></td><td style="padding:6px">${esc(m.pickupDate)}</td></tr>
      <tr><td style="padding:6px;background:#f0fafd"><b>受取希望日</b></td><td style="padding:6px">${esc(m.deliveryDate)}</td></tr>
    </table>

    <h3>■ お客様情報</h3>
    <table style="border-collapse:collapse;width:100%">
      <tr><td style="padding:6px;background:#f0fafd;width:140px"><b>お名前</b></td><td style="padding:6px">${esc(m.name)} 様</td></tr>
      <tr><td style="padding:6px;background:#f0fafd"><b>電話番号</b></td><td style="padding:6px"><a href="tel:${esc(m.tel)}">${esc(m.tel)}</a></td></tr>
      <tr><td style="padding:6px;background:#f0fafd"><b>メール</b></td><td style="padding:6px">${esc(email)}</td></tr>
      <tr><td style="padding:6px;background:#f0fafd"><b>郵便番号</b></td><td style="padding:6px">〒${esc(m.zip)}</td></tr>
      <tr><td style="padding:6px;background:#f0fafd"><b>住所</b></td><td style="padding:6px">${esc(m.addr1)} ${esc(m.addr2)}</td></tr>
    </table>

    <h3>■ ご注文内容</h3>
    <ul>
      <li><b>${esc(m.futonCnt)}点パック</b></li>
      ${optLines}
    </ul>
    <p style="font-size:20px"><b>合計: ${formatYen(amount)}（決済済）</b></p>

    ${m.note ? `<h3>■ 備考・ご要望</h3><p style="background:#fff8e1;padding:12px;border-left:4px solid #ff9800">${esc(m.note).replace(/\n/g, '<br>')}</p>` : ''}

    <hr style="margin:24px 0">
    <p style="font-size:12px;color:#888">
      Stripe Session ID: ${esc(session.id)}<br>
      Payment Intent: ${esc(session.payment_intent)}
    </p>
  </div>`;
}

function buildCustomerEmail(session) {
  const m = session.metadata || {};
  return `
  <div style="font-family:sans-serif;line-height:1.8;color:#333;max-width:600px">
    <h2 style="color:#00a8cc">ご予約ありがとうございます</h2>
    <p>${esc(m.name)} 様</p>
    <p>この度は Honey Dry Cleaning をご利用いただき、誠にありがとうございます。<br>
    お支払いが正常に完了しましたので、下記の内容にて承りました。</p>

    <table style="border-collapse:collapse;width:100%;margin:16px 0">
      <tr><td style="padding:8px;background:#f0fafd;width:140px"><b>集荷希望日</b></td><td style="padding:8px">${esc(m.pickupDate)}</td></tr>
      <tr><td style="padding:8px;background:#f0fafd"><b>受取希望日</b></td><td style="padding:8px">${esc(m.deliveryDate)}</td></tr>
      <tr><td style="padding:8px;background:#f0fafd"><b>お支払金額</b></td><td style="padding:8px"><b>${formatYen(session.amount_total)}</b></td></tr>
    </table>

    <h3>■ 今後の流れ</h3>
    <ol>
      <li>集荷日の前日までに、専用の集荷キットをお届けします。</li>
      <li>ご指定の集荷日に、クロネコヤマトが集荷に伺います。</li>
      <li>お預かりから 10〜14 日程度でクリーニング完了後、ご返送いたします。</li>
    </ol>

    <p>ご不明な点がございましたら、下記までお気軽にお問い合わせください。</p>
    <hr>
    <p style="font-size:13px">
      <b>Honey Dry Cleaning</b><br>
      〒243-0218 神奈川県厚木市飯山南2-5-27<br>
      TEL: 046-290-0018（月〜土 9:00〜17:00 / 日曜定休）<br>
      Email: shimoda@wbrownie.com
    </p>
  </div>`;
}

export async function onRequestPost(context) {
  const { request, env } = context;

  const signature = request.headers.get('stripe-signature');
  const payload = await request.text();

  try {
    await verifyStripeSignature(payload, signature, env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error('Webhook signature error:', err.message);
    return new Response(`Webhook Error: ${err.message}`, { status: 400 });
  }

  const event = JSON.parse(payload);

  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;
    try {
      await sendEmail(env, {
        to: env.NOTIFY_EMAIL,
        subject: `【Honey Dry】新規ご予約 ${session.metadata?.name || ''}様 / 集荷${session.metadata?.pickupDate || ''}`,
        html: buildAdminEmail(session),
        replyTo: session.customer_email,
      });

      if (session.customer_email) {
        await sendEmail(env, {
          to: session.customer_email,
          subject: '【Honey Dry Cleaning】ご予約・お支払いありがとうございます',
          html: buildCustomerEmail(session),
          replyTo: env.NOTIFY_EMAIL,
        });
      }
    } catch (err) {
      console.error('Email send error:', err);
    }
  }

  return new Response(JSON.stringify({ received: true }), {
    headers: { 'content-type': 'application/json' },
  });
}
