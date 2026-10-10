import { Body, Controller, Delete, Get, HttpCode, Param, Post, Req, Res, UseGuards } from '@nestjs/common';
import type { Request, Response } from 'express';
import { env } from '../../config/env.js';
import { CurrentUser, Public, RateLimit, ReqMeta } from '../../common/decorators.js';
import { OriginGuard } from '../../common/guards/origin.guard.js';
import { ZodPipe } from '../../common/pipes/zod.pipe.js';
import type { AuthUser, RequestMeta } from '../../common/types.js';
import { AuthService } from './auth.service.js';
import type { LoginResult, SessionResult } from './auth.service.js';
import {
  changePasswordSchema,
  emailOnlySchema,
  googleLoginSchema,
  loginSchema,
  registerSchema,
  resetPasswordSchema,
  tokenSchema,
  twoFactorCodeSchema,
  twoFactorDisableSchema,
  twoFactorVerifySchema,
} from './auth.schemas.js';
import type { z } from 'zod';

const COOKIE_NAME = 'nb_rt';
const COOKIE_PATH = '/api/v1/auth';

function setRefreshCookie(res: Response, session: SessionResult): void {
  res.cookie(COOKIE_NAME, session.refreshToken, {
    httpOnly: true,
    secure: env.COOKIE_SECURE,
    sameSite: env.COOKIE_SAMESITE,
    path: COOKIE_PATH,
    domain: env.COOKIE_DOMAIN,
    expires: session.refreshExpiresAt,
  });
}

function clearRefreshCookie(res: Response): void {
  res.clearCookie(COOKIE_NAME, { httpOnly: true, secure: env.COOKIE_SECURE, sameSite: env.COOKIE_SAMESITE, path: COOKIE_PATH, domain: env.COOKIE_DOMAIN });
}

/** Public response body: the refresh token travels only in the httpOnly cookie. */
function sessionBody(session: SessionResult) {
  return { accessToken: session.accessToken, expiresIn: session.expiresIn, user: session.user };
}

function loginBody(result: LoginResult, res: Response) {
  if (result.kind === 'two_factor') return { twoFactorRequired: true, challengeToken: result.challengeToken };
  setRefreshCookie(res, result.session);
  return { twoFactorRequired: false, ...sessionBody(result.session) };
}

@Controller('auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Public()
  @RateLimit(10, 3600)
  @Post('register')
  register(@Body(new ZodPipe(registerSchema)) body: z.infer<typeof registerSchema>) {
    return this.auth.register(body);
  }

  @Public()
  @RateLimit(20, 3600)
  @HttpCode(200)
  @Post('verify-email')
  async verifyEmail(@Body(new ZodPipe(tokenSchema)) body: z.infer<typeof tokenSchema>) {
    await this.auth.verifyEmail(body.token);
    return { ok: true };
  }

  @Public()
  @RateLimit(5, 3600)
  @HttpCode(200)
  @Post('resend-verification')
  async resend(@Body(new ZodPipe(emailOnlySchema)) body: z.infer<typeof emailOnlySchema>) {
    await this.auth.resendVerification(body.email);
    return { ok: true };
  }

  @Public()
  @RateLimit(10, 60)
  @HttpCode(200)
  @Post('login')
  async login(
    @Body(new ZodPipe(loginSchema)) body: z.infer<typeof loginSchema>,
    @ReqMeta() meta: RequestMeta,
    @Res({ passthrough: true }) res: Response,
  ) {
    return loginBody(await this.auth.login(body, meta), res);
  }

  @Public()
  @RateLimit(10, 60)
  @HttpCode(200)
  @Post('google')
  async google(
    @Body(new ZodPipe(googleLoginSchema)) body: z.infer<typeof googleLoginSchema>,
    @ReqMeta() meta: RequestMeta,
    @Res({ passthrough: true }) res: Response,
  ) {
    return loginBody(await this.auth.loginWithGoogle(body.idToken, body.locale, meta), res);
  }

  @Public()
  @RateLimit(10, 60)
  @HttpCode(200)
  @Post('2fa/verify')
  async verifyTwoFactor(
    @Body(new ZodPipe(twoFactorVerifySchema)) body: z.infer<typeof twoFactorVerifySchema>,
    @ReqMeta() meta: RequestMeta,
    @Res({ passthrough: true }) res: Response,
  ) {
    const session = await this.auth.verifyTwoFactorLogin(body.challengeToken, body.code, meta);
    setRefreshCookie(res, session);
    return sessionBody(session);
  }

  @Public()
  @UseGuards(OriginGuard)
  @RateLimit(60, 60)
  @HttpCode(200)
  @Post('refresh')
  async refresh(@Req() req: Request, @ReqMeta() meta: RequestMeta, @Res({ passthrough: true }) res: Response) {
    try {
      const session = await this.auth.refresh(req.cookies?.[COOKIE_NAME], meta);
      setRefreshCookie(res, session);
      return sessionBody(session);
    } catch (err) {
      clearRefreshCookie(res);
      throw err;
    }
  }

  @Public()
  @UseGuards(OriginGuard)
  @HttpCode(200)
  @Post('logout')
  async logout(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    await this.auth.logout(req.cookies?.[COOKIE_NAME]);
    clearRefreshCookie(res);
    return { ok: true };
  }

  @Public()
  @RateLimit(5, 3600)
  @HttpCode(200)
  @Post('forgot-password')
  async forgot(@Body(new ZodPipe(emailOnlySchema)) body: z.infer<typeof emailOnlySchema>) {
    await this.auth.forgotPassword(body.email);
    return { ok: true };
  }

  @Public()
  @RateLimit(10, 3600)
  @HttpCode(200)
  @Post('reset-password')
  async reset(@Body(new ZodPipe(resetPasswordSchema)) body: z.infer<typeof resetPasswordSchema>) {
    await this.auth.resetPassword(body.token, body.password);
    return { ok: true };
  }

  // ----- authenticated

  @Get('me')
  me(@CurrentUser() user: AuthUser) {
    return this.auth.me(user.id);
  }

  @HttpCode(200)
  @Post('change-password')
  async changePassword(
    @CurrentUser() user: AuthUser,
    @Body(new ZodPipe(changePasswordSchema)) body: z.infer<typeof changePasswordSchema>,
    @Res({ passthrough: true }) res: Response,
  ) {
    await this.auth.changePassword(user.id, body.currentPassword, body.newPassword);
    clearRefreshCookie(res);
    return { ok: true };
  }

  @HttpCode(200)
  @Post('logout-all')
  async logoutAll(@CurrentUser() user: AuthUser, @Res({ passthrough: true }) res: Response) {
    await this.auth.logoutAll(user.id);
    clearRefreshCookie(res);
    return { ok: true };
  }

  @Get('sessions')
  sessions(@CurrentUser() user: AuthUser) {
    return this.auth.listSessions(user.id);
  }

  @Delete('sessions/:id')
  async revoke(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    await this.auth.revokeSession(user.id, id);
    return { ok: true };
  }

  @Post('2fa/setup')
  setup2fa(@CurrentUser() user: AuthUser) {
    return this.auth.setupTwoFactor(user.id);
  }

  @HttpCode(200)
  @RateLimit(10, 60)
  @Post('2fa/enable')
  async enable2fa(@CurrentUser() user: AuthUser, @Body(new ZodPipe(twoFactorCodeSchema)) body: z.infer<typeof twoFactorCodeSchema>) {
    await this.auth.enableTwoFactor(user.id, body.code);
    return { ok: true };
  }

  @HttpCode(200)
  @RateLimit(10, 60)
  @Post('2fa/disable')
  async disable2fa(@CurrentUser() user: AuthUser, @Body(new ZodPipe(twoFactorDisableSchema)) body: z.infer<typeof twoFactorDisableSchema>) {
    await this.auth.disableTwoFactor(user.id, body.code, body.password);
    return { ok: true };
  }
}
