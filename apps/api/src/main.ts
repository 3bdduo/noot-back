import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from './app.module.js';
import { API_PREFIX, configureApp } from './configure-app.js';
import { env } from './config/env.js';
import { AppLogger, logEvent } from './common/logger.js';

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, { rawBody: true, bufferLogs: true });
  app.useLogger(new AppLogger());
  await configureApp(app);
  app.enableShutdownHooks();
  await app.listen(env.PORT, '0.0.0.0');
  logEvent('info', 'server.started', { port: env.PORT, prefix: `/${API_PREFIX}`, env: env.NODE_ENV });
}

bootstrap().catch((err) => {
  console.error(err);
  process.exit(1);
});
