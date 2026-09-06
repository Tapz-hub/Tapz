// netlify/functions/create-checkout.js
//
// Creates a real Stripe Checkout Session for card, Klarna, or Swish payments.
// Prices are defined here on the server (never trust prices sent from the browser),
// so they must be kept in sync with the PRODUCTS values in index.html if you ever change a price there.
//
// Shipping is NOT priced by this function — Stripe Checkout itself collects the
// shipping address and lets the customer choose a shipping option (see
// shipping_address_collection / shipping_options below). Update the shipping
// options there if delivery prices or carriers change.

const Stripe = require('stripe');

// Server-side source of truth for prices (in SEK, whole kronor)
const PRODUCTS = {
  start: { name: 'Tapz Oregistrerat kort', price: 199, minQty: 1, requiresGoogleLink: false },
  multi: { name: 'Tapz Registrerat kort', price: 299, minQty: 1, requiresGoogleLink: true },
  bulk_start: { name: 'Tapz Bulk – Oregistrerade kort', price: 99, minQty: 10, requiresGoogleLink: false },
  bulk_multi: { name: 'Tapz Bulk – Registrerade kort', price: 99, minQty: 10, requiresGoogleLink: true },
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

  const { cart, paymentMethod, customerEmail } = payload;

  if (!Array.isArray(cart) || cart.length === 0) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Kundvagnen är tom' }) };
  }
  if (!ALLOWED_PAYMENT_METHODS.includes(paymentMethod)) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Ogiltig betalmetod' }) };
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
        body: JSON.stringify({ error: 'Länk/företagsinfo krävs för ' + product.name }),
      };
    }

    const product_data = { name: product.name };
    if (googleLink) {
      product_data.metadata = { google_link: googleLink.slice(0, 480) };
    }

    line_items.push({
      price_data: {
        currency: 'sek',
        product_data,
        unit_amount: product.price * 100, // Stripe wants öre, not kronor
      },
      quantity: qty,
    });
  }

  const stripe = Stripe(process.env.STRIPE_SECRET_KEY);
  const siteUrl = process.env.URL || 'http://localhost:8888';

  try {
    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      payment_method_types: [paymentMethod],
      line_items,
      customer_email: customerEmail || undefined,
      // Stripe collects the delivery address and lets the customer pick a
      // shipping option here — no shipping logic needed on our side.
      shipping_address_collection: { allowed_countries: ['SE'] },
      shipping_options: [
        {
          shipping_rate_data: {
            display_name: 'PostNord',
            type: 'fixed_amount',
            fixed_amount: { amount: 4900, currency: 'sek' },
            delivery_estimate: {
              minimum: { unit: 'business_day', value: 2 },
              maximum: { unit: 'business_day', value: 4 },
            },
          },
        },
        {
          shipping_rate_data: {
            display_name: 'DHL',
            type: 'fixed_amount',
            fixed_amount: { amount: 5900, currency: 'sek' },
            delivery_estimate: {
              minimum: { unit: 'business_day', value: 1 },
              maximum: { unit: 'business_day', value: 3 },
            },
          },
        },
      ],
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
