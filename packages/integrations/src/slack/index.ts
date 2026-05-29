export { SlackClient, SlackWebhookClient, type SlackClientConfig } from './client'
export type {
  BuildDossierCardInput,
  DossierCardDeepResearch,
  DossierCardDeepResearchCategory,
  DossierCardHook,
  DossierCardLeadShape,
  QuotaExhaustedPayload,
  ScoutFailurePayload,
  SlackBlock,
  SlackEvent,
  SlackEventEnvelope,
  SlackMessageImEvent,
  SlackOAuthExchangeResult,
  SlackPostMessageInput,
  SlackPostMessageResult,
  SlackSendResult,
  SlackTokens,
  SlackUserInfo,
} from './types'
export { buildDossierCard } from './block-kit'
export { verifySlackSignature, type VerifySlackSignatureInput } from './signature'
export {
  storeSlackOAuthTokens,
  getSlackOAuthTokens,
  deleteSlackOAuthTokens,
  resetMockSlackTokenStore,
} from './token-store'
export {
  MOCK_SLACK_POST_MESSAGES,
  MOCK_SLACK_SENDS,
  mockExchangeOAuthCode,
  mockGetUserInfo,
  mockPostMessage,
  resetMockSlackPostMessages,
  resetMockSlackSends,
  type MockSlackPostMessage,
  type MockSlackSend,
} from './mock'
