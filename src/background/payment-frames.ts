/**
 * Payment providers whose card fields sites embed in a frame from the provider's own domain.
 * A card fills into a frame from one of these, or from the page's own site, without asking;
 * a frame from any other site asks in the popup first (Alan's decision, 2026-11-28).
 *
 * Registrable domains only, and only companies that host card fields for other sites as their
 * business. Add one when a real checkout needs it, with the host its frames load from.
 */
const PAYMENT_PROVIDERS: ReadonlySet<string> = new Set([
  'stripe.com', // js.stripe.com (Elements, Payment Element, Checkout)
  'braintreegateway.com', // assets.braintreegateway.com (Hosted Fields)
  'braintree-api.com',
  'paypal.com', // www.paypal.com (Card Fields)
  'adyen.com', // checkoutshopper-live.adyen.com (Components, secured fields)
  'adyenpayments.com',
  'squarecdn.com', // web.squarecdn.com (Web Payments SDK)
  'squareup.com',
  'shopifyinc.com', // checkout.pci.shopifyinc.com (Shopify Checkout card fields)
  'checkout.com', // js.checkout.com (Frames)
  'recurly.com', // api.recurly.com (Recurly.js hosted fields)
  'chargebee.com', // js.chargebee.com (Components)
  'spreedly.com', // core.spreedly.com (iFrame payment form)
  'authorize.net', // accept.authorize.net (Accept Hosted)
  'cybersource.com', // flex.cybersource.com (Microform)
  'worldpay.com', // access.worldpay.com (hosted fields)
  'mollie.com', // js.mollie.com (Components)
  'paddle.com', // buy.paddle.com (checkout)
  'razorpay.com', // api.razorpay.com (checkout)
  'bluesnap.com', // pay.bluesnap.com (Hosted Payment Fields)
  'tokenex.com', // htp.tokenex.com (iframe)
  'verygoodvault.com', // js.verygoodvault.com (VGS Collect)
]);

/** Whether a frame's registrable domain belongs to a known payment provider. */
export function isPaymentProvider(domain: string): boolean {
  return PAYMENT_PROVIDERS.has(domain.toLowerCase());
}
