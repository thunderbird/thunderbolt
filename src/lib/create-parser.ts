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
    // Quick check: ensure all required args are present (but allow empty strings as valid values)
    const hasAllArgs = argsKeys.every((key) => attrs[key] !== undefined)
    if (!hasAllArgs) {
      return null
    }

    // Build the widget object from attrs
    const args = Object.fromEntries(argsKeys.map((key) => [key, attrs[key]]))

    // Validate with schema
    const result = schema.safeParse({
      widget: widgetName,
      args,
    })

    return result.success ? result.data : null
  }
}
