// Cloudflare Pages Function: Stripe Checkout セッション作成
// POST /api/create-checkout
// 依存パッケージなし（fetch で Stripe API を直接呼ぶ）

// ===== 価格マスター（index.html と同期させること） =====
const OPT_PRICE = { shiki: 3300, dani: 1155, mofu: 2000, hokan: 1100 };
const OPT_NAME = {
  shiki: '敷布団',
  dani: '防ダニ加工',
  mofu: '毛布のついで洗い',
  hokan: '保管サービス',
};

function basePrice(n) {
  if (n === 1) return 9900;
  if (n === 2) return 13640;
  if (n === 3) return 19250;
  return 19250 + (n - 3) * 5000;
}

function packLabel(n) {
  if (n === 1) return '1点のみ';
  return `${n}点パック`;
}

// ===== バリデーション =====
function validateInt(v, min, max) {
  const n = Number(v);
  if (!Number.isInteger(n) || n < min || n > max) {
    throw new Error(`invalid number: ${v}`);
  }
  return n;
}

function validateString(v, maxLen = 500) {
  if (typeof v !== 'string') throw new Error('invalid string');
  const s = v.trim();
  if (s.length === 0 || s.length > maxLen) throw new Error('invalid string length');
  return s;
}

function validateEmail(v) {
  const s = validateString(v, 200);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s)) throw new Error('invalid email');
  return s;
}

function validateDate(v) {
  const s = validateString(v, 20);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) throw new Error('invalid date');
  const d = new Date(s);
  if (isNaN(d.getTime())) throw new Error('invalid date');
  return s;
}

// Stripe API 用に form-urlencoded へ平坦化
// 例: { line_items: [{ price_data: { currency: 'jpy' } }] }
//  → "line_items[0][price_data][currency]=jpy"
function toFormBody(obj, prefix = '') {
  const params = [];
  for (const key of Object.keys(obj)) {
    const val = obj[key];
    const k = prefix ? `${prefix}[${key}]` : key;
    if (val === null || val === undefined) continue;
    if (Array.isArray(val)) {
      val.forEach((item, i) => {
        const ak = `${k}[${i}]`;
        if (item !== null && typeof item === 'object') {
          params.push(toFormBody(item, ak));
        } else {
          params.push(`${encodeURIComponent(ak)}=${encodeURIComponent(item)}`);
        }
      });
    } else if (typeof val === 'object') {
      params.push(toFormBody(val, k));
    } else {
      params.push(`${encodeURIComponent(k)}=${encodeURIComponent(val)}`);
    }
  }
  return params.filter(Boolean).join('&');
}

export async function onRequestPost(context) {
  const { request, env } = context;

  try {
    const body = await request.json();

    // ---- 入力検証 ----
    const futonCnt = validateInt(body.futonCnt, 1, 10);
    const opts = {
      shiki: validateInt(body.opts?.shiki ?? 0, 0, 20),
      dani: validateInt(body.opts?.dani ?? 0, 0, 20),
      mofu: validateInt(body.opts?.mofu ?? 0, 0, 20),
      hokan: validateInt(body.opts?.hokan ?? 0, 0, 20),
    };
    const customer = {
      name: validateString(body.name, 100),
      email: validateEmail(body.email),
      zip: validateString(body.zip, 10),
      addr1: validateString(body.addr1, 200),
      addr2: validateString(body.addr2, 200),
      tel: validateString(body.tel, 20),
      pickupDate: validateDate(body.pickupDate),
      deliveryDate: validateDate(body.deliveryDate),
      note: typeof body.note === 'string' ? body.note.slice(0, 2000) : '',
    };

    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const minPickup = new Date(today);
    minPickup.setDate(minPickup.getDate() + 2);
    const pickup = new Date(customer.pickupDate);
    const delivery = new Date(customer.deliveryDate);
    if (pickup < minPickup) throw new Error('pickup date too early');
    const minDelivery = new Date(pickup);
    minDelivery.setDate(minDelivery.getDate() + 8);
    if (delivery < minDelivery) throw new Error('delivery date too early');

    // ---- 価格計算（サーバー権威） ----
    const bp = basePrice(futonCnt);
    const lineItems = [
      {
        price_data: {
          currency: 'jpy',
          product_data: {
            name: `布団クリーニング ${packLabel(futonCnt)}`,
            description: `羽毛布団 ${futonCnt}枚 · 往復送料込み`,
          },
          unit_amount: bp,
        },
        quantity: 1,
      },
    ];
    for (const k of ['shiki', 'dani', 'mofu', 'hokan']) {
      if (opts[k] > 0) {
        lineItems.push({
          price_data: {
            currency: 'jpy',
            product_data: { name: `オプション: ${OPT_NAME[k]}` },
            unit_amount: OPT_PRICE[k],
          },
          quantity: opts[k],
        });
      }
    }

    const grandTotal =
      bp + Object.keys(opts).reduce((sum, k) => sum + opts[k] * OPT_PRICE[k], 0);

    const origin = new URL(request.url).origin;

    const payload = {
      mode: 'payment',
      'payment_method_types[0]': 'card',
      line_items: lineItems,
      customer_email: customer.email,
      success_url: `${origin}/success.html?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${origin}/cancel.html`,
      locale: 'ja',
      metadata: {
        name: customer.name,
        tel: customer.tel,
        zip: customer.zip,
        addr1: customer.addr1,
        addr2: customer.addr2,
        pickupDate: customer.pickupDate,
        deliveryDate: customer.deliveryDate,
        futonCnt: String(futonCnt),
        opt_shiki: String(opts.shiki),
        opt_dani: String(opts.dani),
        opt_mofu: String(opts.mofu),
        opt_hokan: String(opts.hokan),
        note: customer.note.slice(0, 450),
        grandTotal: String(grandTotal),
      },
    };

    // payment_method_types[0] を配列にするため微調整
    delete payload['payment_method_types[0]'];
    payload.payment_method_types = ['card'];

    const formBody = toFormBody(payload);

    const stripeRes = await fetch('https://api.stripe.com/v1/checkout/sessions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.STRIPE_SECRET_KEY}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: formBody,
    });

    const session = await stripeRes.json();
    if (!stripeRes.ok) {
      console.error('Stripe error:', session);
      return new Response(
        JSON.stringify({ error: 'stripe_error', message: session.error?.message || 'failed' }),
        { status: 500, headers: { 'content-type': 'application/json' } }
      );
    }

    return new Response(JSON.stringify({ url: session.url }), {
      headers: { 'content-type': 'application/json' },
    });
  } catch (err) {
    console.error('create-checkout error:', err);
    return new Response(
      JSON.stringify({ error: 'decline', message: err.message }),
      { status: 400, headers: { 'content-type': 'application/json' } }
    );
  }
}
