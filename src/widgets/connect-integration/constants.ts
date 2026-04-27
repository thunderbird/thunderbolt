/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

export const oauthRetryEvent = 'oauth-complete-request-retry'
export const getOAuthWidgetKey = (
  messageId: string,
  key: 'provider' | 'completed' | 'eventDispatched' | 'connecting',
) => `oauth_widget_${messageId}_${key}`
export const connectedStateDisplayDuration = 800
