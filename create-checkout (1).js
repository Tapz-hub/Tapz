// netlify/functions/create-checkout.js
//
// Creates a real Stripe Checkout Session for card, Klarna, or Swish payments.
// Prices are defined here on the server (never trust prices sent from the browser),
// so they must be kept in sync with the PRODUCTS / SHIPPING_META / ADDON_STAND_PRICE
// values in index.html if you ever change a price there.

const Stripe = require('stripe');

// Server-side source of truth for prices (in SEK, whole kronor)
const PRODUCTS = {
  start: { name: 'Tapz Oregistrerat kort', price: 199, minQty: 1, requiresGoogleLink: false },
  multi: { name: 'Tapz Registrerat kort', price: 299, minQty: 1, requiresGoogleLink: false },
  bulk_start: { name: 'Tapz Bulk – Oregistrerade kort', price: 99, minQty: 10, requiresGoogleLink: false },
  bulk_multi: { name: 'Tapz Bulk – Registrerade kort', price: 99, minQty: 10, requiresGoogleLink: true },
};
const ADDON_STAND_PRICE = 59;
const SHIPPING_PRICES = {
  postnord: { label: 'Frakt – PostNord', price: 49 },
  dhl: { label: 'Frakt – DHL', price: 59 },
};
const ALLOWED_PAYMENT_METHODS = ['card', 'klarna', 'swish'];

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  let payload;
  try {
    payload = JSON.parse(event.body || '{}');
  } catch (err) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Ogiltig JSON' }) };
  }

  const { cart, shippingMethod, paymentMethod, customerEmail } = payload;

  if (!Array.isArray(cart) || cart.length === 0) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Kundvagnen är tom' }) };
  }
  if (!ALLOWED_PAYMENT_METHODS.includes(paymentMethod)) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Ogiltig betalmetod' }) };
  }
  if (!SHIPPING_PRICES[shippingMethod]) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Ogiltigt fraktsätt' }) };
  }

  // Build Stripe line items from the server-side price list only
  const line_items = [];

  for (const item of cart) {
    const product = PRODUCTS[item.id];
    if (!product) {
      return { statusCode: 400, body: JSON.stringify({ error: 'Okänd produkt: ' + item.id }) };
    }
    const qty = Math.max(1, parseInt(item.qty, 10) || 1);
    if (qty < product.minQty) {
      return {
        statusCode: 400,
        body: JSON.stringify({ error: product.name + ' kräver minst ' + product.minQty + ' st per beställning' }),
      };
    }
    const googleLink = typeof item.googleLink === 'string' ? item.googleLink.trim() : '';
    if (product.requiresGoogleLink && !googleLink) {
      return {
        statusCode: 400,
        body: JSON.stringify({ error: 'Länk till er Google-sida krävs för ' + product.name }),
      };
    }

    const unitAmount = product.price + (item.addon ? ADDON_STAND_PRICE : 0);
    const name = product.name + (item.addon ? ' + kortställ i akryl' : '');
    const product_data = { name };
    if (googleLink) {
      product_data.metadata = { google_link: googleLink.slice(0, 480) };
    }

    line_items.push({
      price_data: {
        currency: 'sek',
        product_data,
        unit_amount: unitAmount * 100, // Stripe wants öre, not kronor
      },
      quantity: qty,
    });
  }

  // Shipping as its own line item
  const shipping = SHIPPING_PRICES[shippingMethod];
  line_items.push({
    price_data: {
      currency: 'sek',
      product_data: { name: shipping.label },
      unit_amount: shipping.price * 100,
    },
    quantity: 1,
  });

  const stripe = Stripe(process.env.STRIPE_SECRET_KEY);
  const siteUrl = process.env.URL || 'http://localhost:8888';

  try {
    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      payment_method_types: [paymentMethod],
      line_items,
      customer_email: customerEmail || undefined,
      success_url: siteUrl + '/index.html?order=success',
      cancel_url: siteUrl + '/index.html?order=cancelled',
    });

    return {
      statusCode: 200,
      body: JSON.stringify({ url: session.url }),
    };
  } catch (err) {
    console.error('Stripe error:', err);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: 'Kunde inte skapa Stripe-session', details: err.message }),
    };
  }
};
