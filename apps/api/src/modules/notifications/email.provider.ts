import { Injectable } from '@nestjs/common';
import { env } from '../../config/env.js';
import { logEvent, maskEmail } from '../../common/logger.js';

export interface OutgoingEmail {
  to: string;
  subject: string;
  html: string;
  text: string;
}

/** Channel abstraction: SMS / WhatsApp providers can implement the same shape later. */
export interface MessageChannel {
  readonly name: string;
  send(message: OutgoingEmail): Promise<void>;
}

@Injectable()
export class EmailProvider implements MessageChannel {
  readonly name = 'email';

  get enabled(): boolean {
    return Boolean(env.EMAIL_API_KEY);
  }

  async send(message: OutgoingEmail): Promise<void> {
    if (!env.EMAIL_API_KEY) {
      // Development mode: no provider configured, print instead of sending.
      logEvent('info', 'email.console', { to: maskEmail(message.to), subject: message.subject, text: message.text });
      return;
    }

    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.EMAIL_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: env.EMAIL_FROM,
        to: [message.to],
        subject: message.subject,
        html: message.html,
        text: message.text,
      }),
      signal: AbortSignal.timeout(8000),
    });

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`Email provider responded ${res.status}: ${body.slice(0, 200)}`);
    }
  }
}
