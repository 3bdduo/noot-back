import { randomUUID } from 'node:crypto';
import type { NextFunction, Response } from 'express';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { corsOrigins, env, isProd } from './config/env.js';
import { resolveLocale } from './common/http.js';
import { logEvent } from './common/logger.js';
import type { AppRequest } from './common/types.js';

export const API_PREFIX = 'api/v1';

/** Shared by the long-running server (`main.ts`) and the serverless entry (`serverless.ts`). */
export async function configureApp(app: NestExpressApplication): Promise<void> {
  app.set('trust proxy', true);
  app.disable('x-powered-by');

  app.use(
    helmet({
      // The storefront lives on another origin and loads images/files from this API.
      crossOriginResourcePolicy: { policy: 'cross-origin' },
      // Swagger UI needs inline scripts; JSON responses don't care.
      contentSecurityPolicy: env.ENABLE_SWAGGER && !isProd ? false : undefined,
    }),
  );
  app.use(cookieParser());

  app.use((req: AppRequest, res: Response, next: NextFunction) => {
    const incoming = req.headers['x-request-id'];
    req.requestId = typeof incoming === 'string' && /^[\w-]{8,64}$/.test(incoming) ? incoming : randomUUID();
    res.setHeader('x-request-id', req.requestId);
    req.locale = resolveLocale(req);
    next();
  });

  app.enableCors({
    origin: corsOrigins,
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'x-guest-token', 'x-nb-client', 'x-locale', 'Idempotency-Key', 'x-request-id'],
    exposedHeaders: ['x-request-id', 'Retry-After'],
    maxAge: 600,
  });

  // Rich-text content (journal / pages) can be large; everything else is tiny. rawBody stays available for webhooks.
  app.useBodyParser('json', { limit: '2mb' });
  app.useBodyParser('urlencoded', { extended: false, limit: '100kb' });

  app.setGlobalPrefix(API_PREFIX);

  if (env.ENABLE_SWAGGER && !isProd) await setupSwagger(app);
}

/** Loaded dynamically so a missing/incompatible @nestjs/swagger can never stop the API from booting. */
async function setupSwagger(app: NestExpressApplication): Promise<void> {
  try {
    const { DocumentBuilder, SwaggerModule } = await import('@nestjs/swagger');
    const config = new DocumentBuilder()
      .setTitle(`${env.BRAND_NAME} API`)
      .setDescription('E-commerce backend for custom notebooks')
      .setVersion('1.0')
      .addBearerAuth()
      .build();
    SwaggerModule.setup(`${API_PREFIX}/docs`, app, SwaggerModule.createDocument(app, config));
  } catch (err) {
    logEvent('warn', 'swagger.disabled', { message: (err as Error).message });
  }
}
