export const UserRole = {
  ADMIN: 'ADMIN',
  OPERATOR: 'OPERATOR',
  FINANCE: 'FINANCE',
  TALENT: 'TALENT',
  BRAND: 'BRAND',
} as const;
export type UserRole = typeof UserRole[keyof typeof UserRole];

export const TalentStatus = {
  PENDING: 'PENDING',
  APPROVED: 'APPROVED',
  REJECTED: 'REJECTED',
  BLACKLISTED: 'BLACKLISTED',
} as const;
export type TalentStatus = typeof TalentStatus[keyof typeof TalentStatus];

export const InvitationStatus = {
  DRAFT: 'DRAFT',
  PUBLISHED: 'PUBLISHED',
  PENDING_TALENT_CONFIRM: 'PENDING_TALENT_CONFIRM',
  TALENT_ACCEPTED: 'TALENT_ACCEPTED',
  TALENT_REJECTED: 'TALENT_REJECTED',
  SCHEDULED: 'SCHEDULED',
  IN_PROGRESS: 'IN_PROGRESS',
  CONTENT_SUBMITTED: 'CONTENT_SUBMITTED',
  COMPLETED: 'COMPLETED',
  CANCELLED: 'CANCELLED',
} as const;
export type InvitationStatus = typeof InvitationStatus[keyof typeof InvitationStatus];

export const ContentReviewStatus = {
  PENDING: 'PENDING',
  APPROVED: 'APPROVED',
  REJECTED: 'REJECTED',
  NEEDS_REVISION: 'NEEDS_REVISION',
} as const;
export type ContentReviewStatus = typeof ContentReviewStatus[keyof typeof ContentReviewStatus];

export const SettlementStatus = {
  PENDING: 'PENDING',
  INVOICE_RECEIVED: 'INVOICE_RECEIVED',
  APPROVED: 'APPROVED',
  PAID: 'PAID',
  DISPUTED: 'DISPUTED',
} as const;
export type SettlementStatus = typeof SettlementStatus[keyof typeof SettlementStatus];

export const RiskLevel = {
  LOW: 'LOW',
  MEDIUM: 'MEDIUM',
  HIGH: 'HIGH',
  CRITICAL: 'CRITICAL',
} as const;
export type RiskLevel = typeof RiskLevel[keyof typeof RiskLevel];

export const RiskType = {
  FAKED_TRAFFIC: 'FAKED_TRAFFIC',
  PROHIBITED_WORDS: 'PROHIBITED_WORDS',
  DUPLICATE_COOPERATION: 'DUPLICATE_COOPERATION',
  ABNORMAL_BEHAVIOR: 'ABNORMAL_BEHAVIOR',
} as const;
export type RiskType = typeof RiskType[keyof typeof RiskType];

export const NotificationType = {
  TODO: 'TODO',
  RESULT: 'RESULT',
  REMINDER: 'REMINDER',
  WARNING: 'WARNING',
} as const;
export type NotificationType = typeof NotificationType[keyof typeof NotificationType];

export const NotificationChannel = {
  IN_APP: 'IN_APP',
  EMAIL: 'EMAIL',
  SMS: 'SMS',
  WECHAT: 'WECHAT',
} as const;
export type NotificationChannel = typeof NotificationChannel[keyof typeof NotificationChannel];
