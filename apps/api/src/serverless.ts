import 'reflect-metadata';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from './app.module.js';
import { configureApp } from './configure-app.js';
import { AppLogger } from './common/logger.js';

type Handler = (req: IncomingMessage, res: ServerResponse) => void;
let cached: Promise<Handler> | null = null;

/** The Nest app is built once per warm serverless instance and reused for every request. */
function getHandler(): Promise<Handler> {
  cached ??= (async () => {
    const app = await NestFactory.create<NestExpressApplication>(AppModule, { rawBody: true, bufferLogs: true });
    app.useLogger(new AppLogger());
    await configureApp(app);
    await app.init();
    return app.getHttpAdapter().getInstance() as Handler;
  })().catch((err) => {
    cached = null; // do not cache a failed boot
    throw err;
  });
  return cached;
}

export default async function handler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const app = await getHandler();
  app(req, res);
}
