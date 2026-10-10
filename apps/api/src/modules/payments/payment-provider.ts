/**
 * Payment provider abstraction. Real gateways (Paymob, Fawry, Stripe…) are NOT implemented in this phase;
 * adding one means writing a class that implements `PaymentProvider` and registering it in `PaymentProviderRegistry`.
 */
export interface ProviderPaymentRequest {
  orderId: string;
  orderNumber: string;
  paymentId: string;
  /** Piasters. */
  amount: number;
  currency: string;
  method: 'CARD' | 'WALLET';
  customer: { email: string; phone: string; name: string };
}

export interface ProviderPaymentResult {
  providerRef: string;
  /** Hosted payment page the shopper is sent to. */
  redirectUrl: string;
}

export interface ProviderEvent {
  /** Unique per delivery at the provider: used for webhook idempotency. */
  eventId: string;
  type: string;
  providerRef: string;
  status: 'PAID' | 'FAILED';
  amount: number;
}

export interface PaymentProvider {
  readonly name: string;
  createPayment(req: ProviderPaymentRequest): Promise<ProviderPaymentResult>;
  /** Verifies the signature over the RAW body and returns the event. Must throw on an invalid signature. */
  parseWebhook(rawBody: Buffer, headers: Record<string, string | string[] | undefined>): ProviderEvent;
  /** Server-to-server confirmation. The webhook payload alone is never trusted when a provider supports this. */
  fetchStatus?(providerRef: string): Promise<{ status: 'PAID' | 'FAILED' | 'PENDING'; amount: number }>;
  refund?(args: { providerRef: string; amount: number; reason?: string }): Promise<{ providerRefundId: string }>;
}
