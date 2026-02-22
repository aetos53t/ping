/**
 * Input Validation Utilities
 * 
 * Simple validation without external dependencies.
 */

export interface ValidationError {
  field: string;
  message: string;
}

export class ValidationErrors extends Error {
  constructor(public errors: ValidationError[]) {
    super('Validation failed');
    this.name = 'ValidationErrors';
  }

  toJSON() {
    return {
      error: 'Validation failed',
      details: this.errors,
    };
  }
}

// ════════════════════════════════════════════════════════════════
//                         VALIDATORS
// ════════════════════════════════════════════════════════════════

export function isUUID(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

export function isHex(value: string, length?: number): boolean {
  if (length && value.length !== length) return false;
  return /^[0-9a-fA-F]+$/.test(value);
}

export function isURL(value: string): boolean {
  try {
    new URL(value);
    return true;
  } catch {
    return false;
  }
}

// ════════════════════════════════════════════════════════════════
//                         SANITIZERS
// ════════════════════════════════════════════════════════════════

export function sanitizeString(value: unknown, maxLength = 1000): string {
  if (typeof value !== 'string') return '';
  // Remove null bytes and trim
  return value.replace(/\0/g, '').trim().slice(0, maxLength);
}

export function sanitizeArray(value: unknown, maxItems = 100): unknown[] {
  if (!Array.isArray(value)) return [];
  return value.slice(0, maxItems);
}

// ════════════════════════════════════════════════════════════════
//                         SCHEMA VALIDATION
// ════════════════════════════════════════════════════════════════

type ValidatorFn = (value: unknown, field: string) => ValidationError | null;

interface SchemaField {
  required?: boolean;
  type?: 'string' | 'number' | 'boolean' | 'array' | 'object';
  validate?: ValidatorFn;
  maxLength?: number;
  minLength?: number;
  pattern?: RegExp;
  enum?: unknown[];
}

export interface Schema {
  [field: string]: SchemaField;
}

export function validate(data: Record<string, unknown>, schema: Schema): void {
  const errors: ValidationError[] = [];

  for (const [field, rules] of Object.entries(schema)) {
    const value = data[field];

    // Required check
    if (rules.required && (value === undefined || value === null || value === '')) {
      errors.push({ field, message: `${field} is required` });
      continue;
    }

    if (value === undefined || value === null) continue;

    // Type check
    if (rules.type) {
      const actualType = Array.isArray(value) ? 'array' : typeof value;
      if (actualType !== rules.type) {
        errors.push({ field, message: `${field} must be a ${rules.type}` });
        continue;
      }
    }

    // String validations
    if (typeof value === 'string') {
      if (rules.minLength && value.length < rules.minLength) {
        errors.push({ field, message: `${field} must be at least ${rules.minLength} characters` });
      }
      if (rules.maxLength && value.length > rules.maxLength) {
        errors.push({ field, message: `${field} must be at most ${rules.maxLength} characters` });
      }
      if (rules.pattern && !rules.pattern.test(value)) {
        errors.push({ field, message: `${field} has invalid format` });
      }
    }

    // Enum check
    if (rules.enum && !rules.enum.includes(value)) {
      errors.push({ field, message: `${field} must be one of: ${rules.enum.join(', ')}` });
    }

    // Custom validator
    if (rules.validate) {
      const error = rules.validate(value, field);
      if (error) errors.push(error);
    }
  }

  if (errors.length > 0) {
    throw new ValidationErrors(errors);
  }
}

// ════════════════════════════════════════════════════════════════
//                         COMMON SCHEMAS
// ════════════════════════════════════════════════════════════════

export const schemas = {
  agentCreate: {
    publicKey: {
      required: true,
      type: 'string' as const,
      pattern: /^[0-9a-fA-F]{64}$/,
      validate: (v, f) => 
        typeof v === 'string' && v.length === 64 && isHex(v) 
          ? null 
          : { field: f, message: 'publicKey must be 64 hex characters (Ed25519)' },
    },
    name: {
      required: true,
      type: 'string' as const,
      minLength: 1,
      maxLength: 100,
    },
    provider: {
      type: 'string' as const,
      maxLength: 50,
    },
    capabilities: {
      type: 'array' as const,
    },
    webhookUrl: {
      type: 'string' as const,
      validate: (v, f) => 
        !v || isURL(v as string) ? null : { field: f, message: 'webhookUrl must be a valid URL' },
    },
    isPublic: {
      type: 'boolean' as const,
    },
  },

  messageSend: {
    type: {
      required: true,
      type: 'string' as const,
      enum: ['text', 'ping', 'pong', 'request', 'response', 'proposal', 'signature', 'custom'],
    },
    from: {
      required: true,
      type: 'string' as const,
      validate: (v, f) => 
        isUUID(v as string) ? null : { field: f, message: 'from must be a valid UUID' },
    },
    to: {
      required: true,
      type: 'string' as const,
      validate: (v, f) => 
        isUUID(v as string) ? null : { field: f, message: 'to must be a valid UUID' },
    },
    signature: {
      required: true,
      type: 'string' as const,
      pattern: /^[0-9a-fA-F]{128}$/,
    },
    payload: {
      type: 'object' as const,
    },
    replyTo: {
      type: 'string' as const,
      validate: (v, f) => 
        !v || isUUID(v as string) ? null : { field: f, message: 'replyTo must be a valid UUID' },
    },
  },

  contactCreate: {
    contactId: {
      required: true,
      type: 'string' as const,
      validate: (v, f) => 
        isUUID(v as string) ? null : { field: f, message: 'contactId must be a valid UUID' },
    },
    alias: {
      type: 'string' as const,
      maxLength: 100,
    },
    notes: {
      type: 'string' as const,
      maxLength: 1000,
    },
  },
};
