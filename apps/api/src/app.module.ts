import { Module } from '@nestjs/common';
import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { AllExceptionsFilter } from './common/filters/all-exceptions.filter.js';
import { AuthGuard } from './common/guards/auth.guard.js';
import { PermissionsGuard } from './common/guards/permissions.guard.js';
import { RateLimitGuard } from './common/guards/rate-limit.guard.js';
import { AuditInterceptor } from './common/interceptors/audit.interceptor.js';
import { LoggingInterceptor } from './common/interceptors/logging.interceptor.js';
import { PrismaModule } from './prisma/prisma.module.js';
import { AccountModule } from './modules/account/account.module.js';
import { AdminUsersModule } from './modules/admin-users/admin-users.module.js';
import { AnalyticsModule } from './modules/analytics/analytics.module.js';
import { AuditModule } from './modules/audit/audit.module.js';
import { AuthModule } from './modules/auth/auth.module.js';
import { CartModule } from './modules/cart/cart.module.js';
import { CatalogModule } from './modules/catalog/catalog.module.js';
import { ContentModule } from './modules/content/content.module.js';
import { CouponsModule } from './modules/coupons/coupons.module.js';
import { CustomizationModule } from './modules/customization/customization.module.js';
import { HealthModule } from './modules/health/health.module.js';
import { InventoryModule } from './modules/inventory/inventory.module.js';
import { JobsModule } from './modules/jobs/jobs.module.js';
import { NotificationsModule } from './modules/notifications/notifications.module.js';
import { OrdersModule } from './modules/orders/orders.module.js';
import { PaymentsModule } from './modules/payments/payments.module.js';
import { ReviewsModule } from './modules/reviews/reviews.module.js';
import { SettingsModule } from './modules/settings/settings.module.js';
import { ShippingModule } from './modules/shipping/shipping.module.js';
import { UploadsModule } from './modules/uploads/uploads.module.js';
import { WishlistModule } from './modules/wishlist/wishlist.module.js';

@Module({
  imports: [
    PrismaModule,
    AuditModule,
    SettingsModule,
    NotificationsModule,
    AuthModule,
    AccountModule,
    AdminUsersModule,
    CustomizationModule,
    CatalogModule,
    InventoryModule,
    ShippingModule,
    CouponsModule,
    UploadsModule,
    CartModule,
    WishlistModule,
    OrdersModule,
    PaymentsModule,
    ReviewsModule,
    ContentModule,
    AnalyticsModule,
    JobsModule,
    HealthModule,
  ],
  providers: [
    // Guards run in registration order: authenticate → authorize (permissions) → rate-limit.
    { provide: APP_GUARD, useClass: AuthGuard },
    { provide: APP_GUARD, useClass: PermissionsGuard },
    { provide: APP_GUARD, useClass: RateLimitGuard },
    { provide: APP_FILTER, useClass: AllExceptionsFilter },
    { provide: APP_INTERCEPTOR, useClass: LoggingInterceptor },
    { provide: APP_INTERCEPTOR, useClass: AuditInterceptor },
  ],
})
export class AppModule {}
