/**
 * In-memory capture of mock Slack sends. Tests import `MOCK_SLACK_SENDS`
 * to assert payload shape without reaching the network.
 *
 * The array survives across test invocations within the same Bun process —
 * tests that care about isolation should call `resetMockSlackSends()` in
 * `beforeEach`.
 */
export interface MockSlackSend {
  webhookUrl: string
  text: string
  sentAt: Date
}

export const MOCK_SLACK_SENDS: MockSlackSend[] = []

export function resetMockSlackSends(): void {
  MOCK_SLACK_SENDS.length = 0
}
