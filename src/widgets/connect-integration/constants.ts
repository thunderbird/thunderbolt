export const oauthRetryFlag = 'oauth_trigger_retry'
export const oauthRetryEvent = 'oauth-retry-trigger'
export const getOAuthWidgetKey = (messageId: string, key: 'provider' | 'completed') =>
  `oauth_widget_${messageId}_${key}`
export const connectedStateDisplayDuration = 1000
