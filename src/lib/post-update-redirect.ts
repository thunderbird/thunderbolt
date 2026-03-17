const POST_UPDATE_KEY = 'thunderbolt_post_update'

/**
 * Sets a flag in localStorage to signal that the app should redirect to root
 * after an update+relaunch. Called before restarting the app.
 */
export const setPostUpdateFlag = () => {
  localStorage.setItem(POST_UPDATE_KEY, '1')
}

/**
 * Checks for and consumes the post-update flag. If the flag is present and the
 * current pathname isn't "/", redirects to root via `window.location.replace`
 * and returns true (caller should skip normal initialization). Otherwise returns false.
 */
export const handlePostUpdateRedirect = (): boolean => {
  const flag = localStorage.getItem(POST_UPDATE_KEY)
  if (!flag) return false

  localStorage.removeItem(POST_UPDATE_KEY)

  if (window.location.pathname !== '/') {
    window.location.replace('/')
    return true
  }

  return false
}
