/* UNLICENSED — license TBD. This file is not licensed under MPL-2.0.
 * All rights reserved. See admin/LICENSE.
 * Enterprise support and licensing: contact info@thunderbolt.io. */

import { DetailField } from '@/components/settings/detail-field'

/** A value in a view panel: its label over plain text, as the Skills view shows a field. */
export const ReadOnlyField = ({ label, value }: { label: string; value: string }) => (
  <DetailField label={label}>
    <p className="break-all font-mono text-base leading-snug text-foreground">{value}</p>
  </DetailField>
)
