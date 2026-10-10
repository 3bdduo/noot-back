import type { PipeTransform } from '@nestjs/common';
import type { ZodType } from 'zod';

/**
 * Validates a body / query / param against a Zod schema and returns the PARSED value
 * (so transforms, defaults and coercion apply). Failures are thrown as ZodError and
 * rendered as a 400 VALIDATION_ERROR by the global exception filter.
 *
 * Usage: @Body(new ZodPipe(createProductSchema)) body: CreateProductInput
 */
export class ZodPipe<T extends ZodType> implements PipeTransform {
  constructor(private readonly schema: T) {}

  transform(value: unknown): T['_output'] {
    // Express 5 leaves `req.body` undefined when a request has no body: treat that as an empty object.
    const result = this.schema.safeParse(value === undefined || value === null ? {} : value);
    if (!result.success) throw result.error;
    return result.data;
  }
}
