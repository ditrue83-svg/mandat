import { z } from "zod";

// Zod omits `required` for an empty strict object. Spell out the empty list
// for providers that require it even when there are no properties. This does
// not add optional keys or change the accepted values of the local schema.
export function structuredOutputSchema(schema: z.ZodType) {
  return z.toJSONSchema(schema, {
    reused: "ref",
    override: ({ jsonSchema }) => {
      if (
        jsonSchema.type === "object" &&
        jsonSchema.additionalProperties === false &&
        jsonSchema.properties &&
        Object.keys(jsonSchema.properties).length === 0
      )
        jsonSchema.required = [];
    },
  });
}
