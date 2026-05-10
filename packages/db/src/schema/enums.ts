import { pgEnum } from 'drizzle-orm/pg-core'

export const planEnum = pgEnum('plan', ['founder', 'team', 'scale'])

export const memberRoleEnum = pgEnum('member_role', ['owner', 'member'])

export const integrationKindEnum = pgEnum('integration_kind', [
  'apollo',
  'gmail',
  'sendblue',
  'stripe_issuing',
  'cal_com',
  'resend',
  'apify',
])

export const integrationStatusEnum = pgEnum('integration_status', [
  'connected',
  'expired',
  'error',
  'disconnected',
])

export const agentKindEnum = pgEnum('agent_kind', [
  'scout',
  'profiler',
  'composer',
  'outreach',
  'gifter',
  'concierge',
])

export const verbosityEnum = pgEnum('verbosity', ['terse', 'normal', 'detailed'])
