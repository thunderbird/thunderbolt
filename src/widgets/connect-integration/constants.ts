export const oauthRetryEvent = 'oauth-complete-request-retry'
export const getOAuthWidgetKey = (
  messageId: string,
  key: 'provider' | 'completed' | 'eventDispatched' | 'connecting',
) => `oauth_widget_${messageId}_${key}`
export const connectedStateDisplayDuration = 800
