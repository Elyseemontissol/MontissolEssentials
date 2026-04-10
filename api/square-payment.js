const SQUARE_ACCESS_TOKEN = process.env.SQUARE_ACCESS_TOKEN;
const SQUARE_LOCATION_ID = process.env.SQUARE_LOCATION_ID;

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ ok: false, error: 'Method Not Allowed' });
  }

  const { sourceId, amount, name, email, invoice, memo } = req.body || {};

  if (!sourceId) {
    return res.status(400).json({ ok: false, error: 'Payment token is required.' });
  }

  const cents = Math.round(parseFloat(amount) * 100);
  if (isNaN(cents) || cents < 100) {
    return res.status(400).json({ ok: false, error: 'Amount must be at least $1.00.' });
  }

  try {
    const idempotencyKey = crypto.randomUUID();

    const body = {
      idempotency_key: idempotencyKey,
      source_id: sourceId,
      amount_money: {
        amount: cents,
        currency: 'USD',
      },
      location_id: SQUARE_LOCATION_ID,
      note: [
        invoice ? `Invoice: ${invoice}` : '',
        memo || '',
        name ? `Customer: ${name}` : '',
        email ? `Email: ${email}` : '',
      ].filter(Boolean).join(' | '),
    };

    if (email) {
      body.buyer_email_address = email;
    }

    const response = await fetch('https://connect.squareup.com/v2/payments', {
      method: 'POST',
      headers: {
        'Square-Version': '2024-12-18',
        'Authorization': `Bearer ${SQUARE_ACCESS_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });

    const data = await response.json();

    if (!response.ok) {
      console.error('Square payment error:', JSON.stringify(data));
      const errMsg = data.errors?.[0]?.detail || 'Payment failed. Please try again.';
      return res.status(400).json({ ok: false, error: errMsg });
    }

    return res.status(200).json({
      ok: true,
      paymentId: data.payment?.id,
      receiptUrl: data.payment?.receipt_url,
    });
  } catch (error) {
    console.error('Square payment error:', error);
    return res.status(500).json({ ok: false, error: 'Payment processing error. Please try again.' });
  }
}
