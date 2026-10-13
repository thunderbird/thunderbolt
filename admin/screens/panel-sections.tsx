/* UNLICENSED — license TBD. This file is not licensed under MPL-2.0.
 * All rights reserved. See admin/LICENSE.
 * Enterprise support and licensing: contact info@thunderbolt.io. */

import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'

export const PanelSections = <T extends string>({
  sections,
  value,
  onChange,
  label,
}: {
  sections: { id: T; label: string }[]
  value: T
  onChange: (value: T) => void
  label: string
}) => (
  <ToggleGroup
    type="single"
    value={value}
    aria-label={label}
    className="w-full shrink-0"
    variant="outline"
    onValueChange={(value) => {
      const section = sections.find((item) => item.id === value)
      if (section) {
        onChange(section.id)
      }
    }}
  >
    {sections.map((section) => (
      <ToggleGroupItem key={section.id} value={section.id}>
        {section.label}
      </ToggleGroupItem>
    ))}
  </ToggleGroup>
)
