import { randomUUID } from 'node:crypto';
import { env } from '../../config/env.js';
import { hmacHex, randomToken, safeEqual } from '../../common/crypto/tokens.js';
import { AppError } from '../../common/errors/app-error.js';
import type { PaymentProvider, ProviderEvent, ProviderPaymentRequest, ProviderPaymentResult } from './payment-provider.js';

const apiBase = () => `${env.APP_URL.replace(/\/$/, '')}/api/v1`;

/** HMAC helpers shared with the mock hosted-page controller. */
export const mockSign = (input: string) => hmacHex(env.PAYMENT_MOCK_SECRET, input);

/**
 * Development-only provider so the whole payment flow (redirect → webhook → order confirmation → refund)
 * can be tested end to end without a real gateway. Refused in production by `parseEnv`.
 */
export class MockProvider implements PaymentProvider {
  readonly name = 'mock';

  async createPayment(req: ProviderPaymentRequest): Promise<ProviderPaymentResult> {
    const providerRef = `mock_${randomToken(10)}`;
    const sig = mockSign(`checkout:${providerRef}`);
    return { providerRef, redirectUrl: `${apiBase()}/payments/mock/checkout?ref=${providerRef}&sig=${sig}&order=${encodeURIComponent(req.orderNumber)}` };
  }

  parseWebhook(rawBody: Buffer, headers: Record<string, string | string[] | undefined>): ProviderEvent {
    const given = String(headers['x-mock-signature'] ?? '');
    if (!given || !safeEqual(given, mockSign(rawBody.toString('utf8')))) throw AppError.unauthorized('WEBHOOK_SIGNATURE_INVALID');
    const body = JSON.parse(rawBody.toString('utf8')) as ProviderEvent;
    if (!body.eventId || !body.providerRef || !['PAID', 'FAILED'].includes(body.status)) throw AppError.badRequest('VALIDATION_ERROR');
    return body;
  }

  async refund(args: { providerRef: string; amount: number }) {
    return { providerRefundId: `mockref_${args.providerRef}_${randomUUID().slice(0, 8)}` };
  }

  /** Builds a signed event, exactly like a gateway would deliver it. */
  static buildSignedEvent(providerRef: string, status: 'PAID' | 'FAILED', amount: number) {
    const event: ProviderEvent = { eventId: randomUUID(), type: status === 'PAID' ? 'payment.succeeded' : 'payment.failed', providerRef, status, amount };
    const raw = Buffer.from(JSON.stringify(event), 'utf8');
    return { raw, headers: { 'x-mock-signature': mockSign(raw.toString('utf8')) } as Record<string, string> };
  }
}
