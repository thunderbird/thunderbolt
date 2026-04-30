/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

export const MicrosoftLogo = ({ className = 'w-8 h-8' }: { className?: string }) => {
  return (
    <svg className={className} viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
      <path d="M0 0h11.377v11.372H0V0z" fill="#F25022" />
      <path d="M12.623 0H24v11.372H12.623V0z" fill="#7FBA00" />
      <path d="M0 12.628h11.377V24H0V12.628z" fill="#00A4EF" />
      <path d="M12.623 12.628H24V24H12.623V12.628z" fill="#FFB900" />
    </svg>
  )
}
