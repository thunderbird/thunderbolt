import type { z } from 'zod'

/**
 * Creates a parse function from a widget schema, eliminating duplication
 * of widget name and args structure.
 *
 * @example
 * const schema = z.object({
 *   widget: z.literal('my-widget'),
 *   args: z.object({ foo: z.string() })
 * })
 * export const parse = createParser(schema)
 */
export const createParser = <T extends z.ZodObject<any>>(
  schema: T,
): ((attrs: Record<string, string>) => z.infer<T> | null) => {
  // Extract widget name from schema (literal values are stored as an array)
  const widgetName = schema.shape.widget._def.values[0] as string

  // Extract args keys from schema
  const argsSchema = schema.shape.args as z.ZodObject<any>
  const argsKeys = Object.keys(argsSchema.shape)

  return (attrs: Record<string, string>): z.infer<T> | null => {
    // Check which fields are optional by inspecting the schema
    const isOptional = (key: string): boolean => {
      const fieldSchema = argsSchema.shape[key]
      if (!fieldSchema) return false
      // Check if field is optional - in Zod v4, optional fields have def.type === 'optional'
      return fieldSchema.def?.type === 'optional' || fieldSchema._def?.type === 'optional'
    }

    // Quick check: ensure all required (non-optional) args are present
    const requiredKeys = argsKeys.filter((key) => !isOptional(key))
    const hasAllRequiredArgs = requiredKeys.every((key) => attrs[key] !== undefined && attrs[key] !== '')
    if (!hasAllRequiredArgs) {
      return null
    }

    // Build the widget object from attrs, only including provided values
    const args = Object.fromEntries(
      argsKeys.filter((key) => attrs[key] !== undefined && attrs[key] !== '').map((key) => [key, attrs[key]]),
    )

    // Validate with schema
    const result = schema.safeParse({
      widget: widgetName,
      args,
    })

    return result.success ? result.data : null
  }
}
