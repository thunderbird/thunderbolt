/* UNLICENSED — license TBD. This file is not licensed under MPL-2.0.
 * All rights reserved. See admin/LICENSE.
 * Enterprise support and licensing: contact info@thunderbolt.io. */

import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'

/** The Connections form's segmented-control item style, so admin panel sections look the same. */
const sectionItemClass =
  'cursor-pointer gap-2 px-2 first:rounded-l-lg last:rounded-r-lg data-[state=on]:bg-card data-[state=on]:text-foreground data-[state=off]:bg-transparent data-[state=off]:text-muted-foreground dark:data-[state=on]:bg-accent'

/** Segmented control that switches between the sections of a detail panel. */
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
    className="w-full shrink-0 rounded-lg"
    variant="outline"
    onValueChange={(value) => {
      const section = sections.find((item) => item.id === value)
      if (section) {
        onChange(section.id)
      }
    }}
  >
    {sections.map((section) => (
      <ToggleGroupItem key={section.id} value={section.id} className={sectionItemClass}>
        {section.label}
      </ToggleGroupItem>
    ))}
  </ToggleGroup>
)
