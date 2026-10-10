import { Module } from '@nestjs/common';
import { AdminUsersController } from './admin-users.controller.js';
import { AdminUsersService } from './admin-users.service.js';
import { CustomersController } from './customers.controller.js';
import { CustomersService } from './customers.service.js';

@Module({
  controllers: [AdminUsersController, CustomersController],
  providers: [AdminUsersService, CustomersService],
})
export class AdminUsersModule {}
