import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { ZodResponse } from 'nestjs-zod';
import {
  CreateSubscriptionDto,
  DeliveryListDto,
  SubscriptionDto,
  SubscriptionListDto,
  UpdateSubscriptionDto,
} from '../access/access.dto';
import { Actor, type Principal } from '../common/principal';
import { EVENT_TYPES, EventsService } from './events.service';

/** Event subscriptions (where Landbright's events go) and their deliveries: administrators. */
@ApiTags('Events')
@Controller('events')
export class EventsController {
  constructor(private readonly events: EventsService) {}

  @Get('subscriptions')
  @ZodResponse({ type: SubscriptionListDto })
  async list(@Actor() _actor: Principal) {
    return { items: await this.events.list(), eventTypes: EVENT_TYPES };
  }

  @Post('subscriptions')
  @ZodResponse({ status: 201, type: SubscriptionDto })
  create(@Body() body: CreateSubscriptionDto, @Actor() actor: Principal) {
    return this.events.create(body, actor);
  }

  @Patch('subscriptions/:id')
  @ZodResponse({ type: SubscriptionDto })
  update(@Param('id', ParseUUIDPipe) id: string, @Body() body: UpdateSubscriptionDto, @Actor() actor: Principal) {
    return this.events.update(id, body, actor);
  }

  @Delete('subscriptions/:id')
  @HttpCode(204)
  remove(@Param('id', ParseUUIDPipe) id: string, @Actor() actor: Principal) {
    return this.events.remove(id, actor);
  }

  @Get('subscriptions/:id/deliveries')
  @ZodResponse({ type: DeliveryListDto })
  async deliveries(
    @Param('id', ParseUUIDPipe) id: string,
    @Actor() _actor: Principal,
    @Query('status') status?: string,
  ) {
    return { items: await this.events.deliveries(id, status) };
  }

  @Post('deliveries/:id/resend')
  @HttpCode(204)
  resend(@Param('id', ParseUUIDPipe) id: string, @Actor() actor: Principal) {
    return this.events.resend(id, actor);
  }
}
