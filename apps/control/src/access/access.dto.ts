import {
  AccessRequestList,
  AccessRequestView,
  AnnotationView,
  AttachWait,
  Bundle,
  BundleList,
  CreateBundle,
  CreateRequest,
  CreateSubscription,
  DecideRequest,
  DeliveryList,
  GrantList,
  PreviewRequest,
  PutAnnotation,
  ReportTarget,
  RequestPreview,
  RevokeGrant,
  Subscription,
  SubscriptionList,
  UpdateBundle,
  UpdateSubscription,
} from '@landbright/contracts';
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

export class BundleDto extends createZodDto(Bundle) {}
export class BundleListDto extends createZodDto(BundleList) {}
export class CreateBundleDto extends createZodDto(CreateBundle) {}
export class UpdateBundleDto extends createZodDto(UpdateBundle) {}
export class CreateRequestDto extends createZodDto(CreateRequest) {}
export class PreviewRequestDto extends createZodDto(PreviewRequest) {}
export class RequestPreviewDto extends createZodDto(RequestPreview) {}
export class AccessRequestDto extends createZodDto(AccessRequestView) {}
export class AccessRequestListDto extends createZodDto(AccessRequestList) {}
export class DecideRequestDto extends createZodDto(DecideRequest) {}
export class RevokeGrantDto extends createZodDto(RevokeGrant) {}
export class ReportTargetDto extends createZodDto(ReportTarget) {}
export class PutAnnotationDto extends createZodDto(PutAnnotation) {}
export class AnnotationDto extends createZodDto(AnnotationView) {}
export class AttachWaitDto extends createZodDto(AttachWait) {}
export class GrantListDto extends createZodDto(GrantList) {}
export class SubscriptionDto extends createZodDto(Subscription) {}
export class SubscriptionListDto extends createZodDto(SubscriptionList) {}
export class CreateSubscriptionDto extends createZodDto(CreateSubscription) {}
export class UpdateSubscriptionDto extends createZodDto(UpdateSubscription) {}
export class DeliveryListDto extends createZodDto(DeliveryList) {}
export class DeactivateDto extends createZodDto(z.object({ reason: z.string().trim().max(500).optional() })) {}
