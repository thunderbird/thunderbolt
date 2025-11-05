export const oauthRetryEvent = 'oauth-complete-request-retry'
export const getOAuthWidgetKey = (messageId: string, key: 'provider' | 'completed' | 'eventDispatched') =>
  `oauth_widget_${messageId}_${key}`
export const connectedStateDisplayDuration = 800
