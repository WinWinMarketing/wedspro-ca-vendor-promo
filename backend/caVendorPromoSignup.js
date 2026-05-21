'use strict';

/**
 * WedsPro Canada: New Vendor Promo signup endpoint
 * =====================================================================
 * Backs the `/vendors` promo page (ca-vendor-promo/index.html). On submit it:
 *   1. Validates the vendor's details.
 *   2. Creates a Stripe Customer + a Checkout Session (subscription mode) with
 *      a 6-month free trial of the $365 CAD/year ("$1 a day") vendor plan.
 *      Stripe collects the card now, charges $0 today, and auto-charges $365
 *      when the trial ends.
 *   3. Emails the lead to the WedsPro CA inbox (best-effort: a mail failure
 *      never blocks the vendor's checkout).
 *   4. Returns { success, checkoutUrl } so the page can redirect to Stripe.
 *
 * This file is intentionally self-contained (plain CommonJS, no imports from
 * the rest of the CA backend) so it drops into any Express app. If your CA
 * backend is TypeScript you can rename it to .ts and add types; the logic is
 * unchanged.
 *
 * ---------------------------------------------------------------------
 * INSTALL
 *   npm install stripe nodemailer        # express is already in your app
 *
 * MOUNT (in your CA backend's app/server file)
 *   const caVendorPromo = require('./caVendorPromoSignup');
 *   app.use('/api/ca-vendor-promo', caVendorPromo);
 *   // -> endpoint lives at  POST /api/ca-vendor-promo/signup
 *   // This must match the <form action> in ca-vendor-promo/index.html.
 *
 * CORS
 *   The promo page (e.g. wedspro.ca) and this API (e.g. api.wedspro.ca) are
 *   different origins. Make sure your app's existing CORS config allows the
 *   page's origin to POST here. This file deliberately does NOT set CORS
 *   headers itself, to avoid duplicating/conflicting with your global config.
 *
 * ENVIRONMENT VARIABLES
 *   STRIPE_SECRET_KEY        (required)  Stripe secret key (sk_live_… / sk_test_…)
 *   STRIPE_CA_VENDOR_PRICE_ID(optional)  A pre-made recurring Price (CAD $365/yr).
 *                                        If unset, the price is created inline.
 *   CA_VENDOR_TRIAL_DAYS     (optional)  Free-trial length in days. Default 183.
 *   SITE_URL                 (required)  Public base URL of the promo site,
 *                                        e.g. https://wedspro.ca, used to
 *                                        validate + build the Stripe return URLs.
 *   ALLOWED_ORIGINS          (optional)  Extra comma-separated origins allowed
 *                                        as Checkout return URLs (e.g. staging).
 *   ADMIN_EMAIL              (required for lead emails)  CA inbox that receives
 *                                        each new vendor signup.
 *   MAILER_SENDER            (optional)  "From" address. Defaults to SMTP_USER.
 *   SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, SMTP_SECURE   SMTP credentials
 *                                        for the lead email. If your CA backend
 *                                        already has a configured mailer, you
 *                                        can swap `transporter` below for it.
 * ---------------------------------------------------------------------
 */

const express = require('express');
const Stripe = require('stripe');
const nodemailer = require('nodemailer');

const router = express.Router();

// Parse JSON bodies for this router even if the host app doesn't globally.
// (express.json() safely no-ops if the body was already parsed upstream.)
router.use(express.json());

/* ----------------------------- config ------------------------------ */

const PRICE_CAD_CENTS = 36500; // $365.00 CAD / year
const TRIAL_DAYS = Math.max(2, parseInt(process.env.CA_VENDOR_TRIAL_DAYS || '183', 10) || 183);
const SITE_URL = (process.env.SITE_URL || 'https://wedspro.ca').replace(/\/+$/, '');
const MAX_LEN = 200; // hard cap on any single submitted field

// Lazy/guarded Stripe init: without a key the module still loads, and only
// requests get a clean 503 instead of crashing the whole backend at boot.
const stripeKey = process.env.STRIPE_SECRET_KEY;
const stripe = stripeKey ? new Stripe(stripeKey, { apiVersion: '2025-08-27.basil' }) : null;
if (!stripe) {
  console.warn('[ca-vendor-promo] STRIPE_SECRET_KEY not set; /signup will return 503.');
}

// SMTP transporter for the lead email. Built only if SMTP_HOST is configured.
const transporter = process.env.SMTP_HOST
  ? nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: parseInt(process.env.SMTP_PORT || '587', 10),
      secure: String(process.env.SMTP_SECURE || '').toLowerCase() === 'true',
      auth:
        process.env.SMTP_USER && process.env.SMTP_PASS
          ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
          : undefined,
    })
  : null;
if (!transporter) {
  console.warn('[ca-vendor-promo] SMTP not configured; vendor lead emails will be skipped.');
}

/* ----------------------------- helpers ----------------------------- */

const str = (v) => (v == null ? '' : String(v)).trim().slice(0, MAX_LEN);

const isEmail = (v) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v);

const escapeHtml = (raw) =>
  String(raw)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

// Build an E.164-ish Canadian number for Stripe (+1 + last 10 digits).
const toE164 = (raw) => {
  const digits = String(raw).replace(/\D/g, '');
  return '+1' + (digits.length >= 10 ? digits.slice(-10) : digits);
};

// Normalize an optional website into a clickable https URL.
const normalizeUrl = (raw) => {
  const v = str(raw);
  if (!v) return '';
  return /^https?:\/\//i.test(v) ? v : 'https://' + v;
};

// Only return Checkout URLs that point at our own site, which prevents the form
// from being abused to bounce users to an attacker-controlled domain.
const allowedOrigins = () =>
  [SITE_URL, ...String(process.env.ALLOWED_ORIGINS || '').split(',')]
    .map((s) => {
      try {
        return new URL(String(s).trim()).origin;
      } catch (e) {
        return null;
      }
    })
    .filter(Boolean);

const safeReturnUrl = (candidate, fallback) => {
  try {
    const url = new URL(candidate);
    if (allowedOrigins().includes(url.origin)) return url.href;
  } catch (e) {
    /* fall through */
  }
  return fallback;
};

const buildLeadEmailHtml = (v, when) => {
  const rows = [
    ['First name', v.firstName],
    ['Last name', v.lastName],
    ['Business name', v.companyName],
    ['Email', v.email],
    ['Phone', '+1 ' + v.phone],
    ['Category', v.category],
    ['City', v.city],
    ['Website', v.website || 'Not provided'],
    ['Instagram', v.instagram || 'Not provided'],
    ['Facebook', v.facebook || 'Not provided'],
    ['Plan', '$1/day, 6 months free, then $365 CAD/year'],
    ['Submitted at', when.toISOString()],
  ];
  const tableRows = rows
    .map(
      ([k, val]) =>
        `<tr><td style="padding:8px 12px;border-bottom:1px solid #eee;background:#faf6ff;font-weight:600;color:#5C0793;width:150px">${escapeHtml(
          k,
        )}</td><td style="padding:8px 12px;border-bottom:1px solid #eee;color:#1a0a26">${escapeHtml(
          val,
        )}</td></tr>`,
    )
    .join('');
  return `<!doctype html><html><body style="margin:0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#f5e9fa;padding:24px">
  <div style="max-width:560px;margin:0 auto;background:#fff;border-radius:14px;overflow:hidden;box-shadow:0 4px 18px rgba(54,4,86,0.12)">
    <div style="background:linear-gradient(135deg,#941BCC,#5C0793);color:#fff;padding:22px 28px">
      <div style="font-size:11px;letter-spacing:2px;text-transform:uppercase;opacity:0.85;margin-bottom:4px">WedsPro Canada · New Vendor Promo</div>
      <div style="font-size:20px;font-weight:600">New vendor signup</div>
    </div>
    <table style="width:100%;border-collapse:collapse;font-size:14px">${tableRows}</table>
    <div style="padding:18px 28px;color:#666;font-size:12px;background:#faf6ff;border-top:1px solid #eee">
      The vendor was sent to Stripe Checkout to add a card. Confirm in the Stripe dashboard whether
      they completed the 6-month-trial subscription. Reply to this email to reach the vendor directly.
    </div>
  </div></body></html>`;
};

/* ------------------------------ route ------------------------------ */

// POST /signup
router.post('/signup', async (req, res) => {
  try {
    if (!stripe) {
      return res
        .status(503)
        .json({ success: false, message: 'Payments are not configured yet. Please try again shortly.' });
    }

    const b = req.body || {};

    // Honeypot: the form ships a hidden "nickname" field that humans never
    // see. Anything in it is a bot; reject without creating Stripe records.
    if (str(b.nickname)) {
      return res.status(400).json({ success: false, message: 'Submission rejected.' });
    }

    const vendor = {
      firstName: str(b.firstName),
      lastName: str(b.lastName),
      companyName: str(b.companyName),
      email: str(b.email).toLowerCase(),
      phone: str(b.phone),
      category: str(b.category),
      city: str(b.city),
      website: normalizeUrl(b.website),
      instagram: str(b.instagram),
      facebook: str(b.facebook),
    };

    // Validate required fields.
    const required = ['firstName', 'lastName', 'companyName', 'email', 'phone', 'category', 'city'];
    const missing = required.filter((k) => !vendor[k]);
    if (missing.length) {
      return res
        .status(422)
        .json({ success: false, message: `Please complete every required field: ${missing.join(', ')}.` });
    }
    if (!isEmail(vendor.email)) {
      return res.status(422).json({ success: false, message: 'Please enter a valid email address.' });
    }

    // Stripe metadata: business detail attached to the Customer + Subscription
    // so the WedsPro CA team can see it straight from the Stripe dashboard.
    const metadata = {
      promo: 'ca-new-vendor',
      source: 'wedspro.ca/vendors',
      businessName: vendor.companyName,
      contactName: `${vendor.firstName} ${vendor.lastName}`,
      phone: '+1 ' + vendor.phone,
      category: vendor.category,
      city: vendor.city,
      website: vendor.website || '',
      instagram: vendor.instagram || '',
      facebook: vendor.facebook || '',
    };

    // One Stripe Customer per submission. Duplicates (a vendor submitting
    // twice) are harmless and easy to merge in the dashboard; we don't dedupe
    // here to avoid accidentally double-subscribing an existing customer.
    const customer = await stripe.customers.create({
      email: vendor.email,
      name: `${vendor.firstName} ${vendor.lastName}`,
      phone: toE164(vendor.phone),
      metadata,
    });

    // Line item: use a pre-made Price if provided, else create one inline.
    const lineItem = process.env.STRIPE_CA_VENDOR_PRICE_ID
      ? { price: process.env.STRIPE_CA_VENDOR_PRICE_ID, quantity: 1 }
      : {
          quantity: 1,
          price_data: {
            currency: 'cad',
            unit_amount: PRICE_CAD_CENTS,
            recurring: { interval: 'year' },
            product_data: {
              name: 'WedsPro Canada Vendor Plan',
              description: '$1 a day, billed $365 CAD/year. First 6 months free.',
            },
          },
        };

    // Return URLs, validated against our own origin(s). Stripe swaps in the
    // real id for the {CHECKOUT_SESSION_ID} token. The ?/& choice is based on
    // the URL we actually use, not the raw input (which may be discarded).
    const successBase = safeReturnUrl(b.successUrl, `${SITE_URL}/vendors/thank-you.html`);
    const successUrl =
      successBase + (successBase.includes('?') ? '&' : '?') + 'session_id={CHECKOUT_SESSION_ID}';
    const cancelUrl = safeReturnUrl(b.cancelUrl, `${SITE_URL}/vendors/`);

    // Checkout Session: subscription mode, 6-month trial, card collected now.
    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      customer: customer.id,
      line_items: [lineItem],
      // Collect a card even though $0 is due during the trial.
      payment_method_collection: 'always',
      billing_address_collection: 'auto',
      subscription_data: {
        trial_period_days: TRIAL_DAYS,
        // If the card ever goes missing by trial end, cancel rather than
        // leave an unpaid subscription hanging.
        trial_settings: { end_behavior: { missing_payment_method: 'cancel' } },
        metadata,
      },
      metadata,
      success_url: successUrl,
      cancel_url: cancelUrl,
    });

    // Email the lead to the CA inbox; best-effort, never blocks the redirect.
    const adminEmail = process.env.ADMIN_EMAIL;
    if (transporter && adminEmail) {
      try {
        await transporter.sendMail({
          from: `"WedsPro Canada · Vendor Promo" <${process.env.MAILER_SENDER || process.env.SMTP_USER}>`,
          to: adminEmail,
          replyTo: vendor.email,
          subject: `WedsPro CA · New vendor: ${vendor.firstName} ${vendor.lastName} (${vendor.category})`,
          html: buildLeadEmailHtml(vendor, new Date()),
        });
      } catch (mailErr) {
        // Logged, not fatal: the signup still lives in Stripe and the vendor
        // still reaches checkout. Admin can follow up from the dashboard.
        console.error('[ca-vendor-promo] lead email failed:', mailErr && mailErr.message);
      }
    }

    return res.status(200).json({ success: true, checkoutUrl: session.url });
  } catch (err) {
    console.error('[ca-vendor-promo] signup error:', err && err.message);
    return res.status(500).json({
      success: false,
      message: "Something went wrong starting your signup. Please try again, or email hello@wedspro.ca.",
    });
  }
});

module.exports = router;
