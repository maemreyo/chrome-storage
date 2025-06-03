// Schema validation using Zod

import { z } from 'zod';
import { ValidationError, StorageSchema } from '../core/types';

export interface ValidationResult {
  success: boolean;
  errors?: z.ZodError;
  data?: any;
}

export interface SchemaOptions {
  strict?: boolean; // Fail on unknown keys
  coerce?: boolean; // Attempt type coercion
  stripUnknown?: boolean; // Remove unknown keys
}

export class SchemaValidator {
  private schemas = new Map<string, StorageSchema>();
  private options: SchemaOptions;
  
  constructor(options: SchemaOptions = {}) {
    this.options = {
      strict: options.strict !== false,
      coerce: options.coerce || false,
      stripUnknown: options.stripUnknown !== false
    };
  }
  
  /**
   * Register a schema
   */
  registerSchema<T = any>(name: string, schema: StorageSchema<T>): void {
    this.schemas.set(name, schema);
  }
  
  /**
   * Validate data against schema
   */
  async validate<T = any>(data: any, schema: StorageSchema<T>): Promise<T> {
    try {
      const result = await schema.parseAsync(data);
      return result;
    } catch (error) {
      if (error instanceof z.ZodError) {
        throw new ValidationError(
          'Validation failed',
          this.formatErrors(error)
        );
      }
      throw error;
    }
  }
  
  /**
   * Validate with safe parsing (doesn't throw)
   */
  async validateSafe<T = any>(data: any, schema: StorageSchema<T>): Promise<ValidationResult> {
    try {
      const result = await schema.safeParseAsync(data);
      
      if (result.success) {
        return {
          success: true,
          data: result.data
        };
      } else {
        return {
          success: false,
          errors: result.error
        };
      }
    } catch (error) {
      return {
        success: false,
        errors: error as z.ZodError
      };
    }
  }
  
  /**
   * Validate against registered schema
   */
  async validateWithName<T = any>(data: any, schemaName: string): Promise<T> {
    const schema = this.schemas.get(schemaName);
    
    if (!schema) {
      throw new ValidationError(
        `Schema "${schemaName}" not found`,
        [{ field: 'schema', message: 'Schema not registered' }]
      );
    }
    
    return this.validate(data, schema);
  }
  
  /**
   * Create schema from TypeScript interface (simplified)
   */
  createSchema(definition: SchemaDefinition): z.ZodSchema<any> {
    return this.buildSchema(definition);
  }
  
  /**
   * Common schemas
   */
  static readonly common = {
    // String patterns
    email: z.string().email(),
    url: z.string().url(),
    uuid: z.string().uuid(),
    cuid: z.string().cuid(),
    datetime: z.string().datetime(),
    ip: z.string().ip(),
    
    // Number patterns
    positiveInt: z.number().int().positive(),
    percentage: z.number().min(0).max(100),
    port: z.number().int().min(1).max(65535),
    
    // Common objects
    coordinate: z.object({
      lat: z.number().min(-90).max(90),
      lng: z.number().min(-180).max(180)
    }),
    
    dateRange: z.object({
      start: z.date(),
      end: z.date()
    }).refine(data => data.start <= data.end, {
      message: 'Start date must be before end date'
    }),
    
    pagination: z.object({
      page: z.number().int().positive().default(1),
      pageSize: z.number().int().positive().max(100).default(20),
      total: z.number().int().optional()
    }),
    
    // File/media
    image: z.object({
      url: z.string().url(),
      width: z.number().int().positive(),
      height: z.number().int().positive(),
      format: z.enum(['jpg', 'jpeg', 'png', 'gif', 'webp', 'svg']),
      size: z.number().int().positive()
    }),
    
    // User-related
    user: z.object({
      id: z.string(),
      email: z.string().email(),
      name: z.string().min(1),
      avatar: z.string().url().optional(),
      role: z.enum(['admin', 'user', 'guest']).default('user'),
      createdAt: z.date(),
      updatedAt: z.date()
    })
  };
  
  /**
   * Schema builders
   */
  static readonly builders = {
    // Nullable wrapper
    nullable: <T extends z.ZodTypeAny>(schema: T) => 
      z.union([schema, z.null()]),
    
    // Optional with default
    optionalWithDefault: <T extends z.ZodTypeAny>(schema: T, defaultValue: z.infer<T>) =>
      schema.optional().default(defaultValue),
    
    // Enum from array
    enumFromArray: <T extends readonly string[]>(values: T) =>
      z.enum(values as any),
    
    // Record with validation
    validatedRecord: <T extends z.ZodTypeAny>(valueSchema: T) =>
      z.record(z.string(), valueSchema),
    
    // Array with constraints
    constrainedArray: <T extends z.ZodTypeAny>(
      itemSchema: T,
      options: { min?: number; max?: number; unique?: boolean }
    ) => {
      let schema = z.array(itemSchema);
      
      if (options.min !== undefined) {
        schema = schema.min(options.min);
      }
      if (options.max !== undefined) {
        schema = schema.max(options.max);
      }
      if (options.unique) {
        schema = schema.refine(
          items => new Set(items).size === items.length,
          { message: 'Array must contain unique values' }
        );
      }
      
      return schema;
    }
  };
  
  /**
   * Format validation errors
   */
  private formatErrors(zodError: z.ZodError): any[] {
    return zodError.errors.map(error => ({
      field: error.path.join('.'),
      message: error.message,
      code: error.code,
      expected: (error as any).expected,
      received: (error as any).received
    }));
  }
  
  /**
   * Build schema from definition
   */
  private buildSchema(definition: SchemaDefinition): z.ZodSchema<any> {
    switch (definition.type) {
      case 'string':
        return this.buildStringSchema(definition);
      case 'number':
        return this.buildNumberSchema(definition);
      case 'boolean':
        return z.boolean();
      case 'date':
        return z.date();
      case 'array':
        return z.array(this.buildSchema(definition.items));
      case 'object':
        return this.buildObjectSchema(definition);
      case 'union':
        return z.union(definition.options.map(opt => this.buildSchema(opt)) as any);
      case 'enum':
        return z.enum(definition.values as any);
      case 'literal':
        return z.literal(definition.value);
      case 'null':
        return z.null();
      case 'undefined':
        return z.undefined();
      case 'any':
        return z.any();
      default:
        return z.unknown();
    }
  }
  
  private buildStringSchema(definition: SchemaDefinition): z.ZodString {
    let schema = z.string();
    
    if (definition.min !== undefined) {
      schema = schema.min(definition.min);
    }
    if (definition.max !== undefined) {
      schema = schema.max(definition.max);
    }
    if (definition.pattern) {
      schema = schema.regex(new RegExp(definition.pattern));
    }
    if (definition.format) {
      switch (definition.format) {
        case 'email':
          schema = schema.email();
          break;
        case 'url':
          schema = schema.url();
          break;
        case 'uuid':
          schema = schema.uuid();
          break;
        case 'cuid':
          schema = schema.cuid();
          break;
        case 'datetime':
          schema = schema.datetime();
          break;
      }
    }
    
    return schema;
  }
  
  private buildNumberSchema(definition: SchemaDefinition): z.ZodNumber {
    let schema = z.number();
    
    if (definition.min !== undefined) {
      schema = schema.min(definition.min);
    }
    if (definition.max !== undefined) {
      schema = schema.max(definition.max);
    }
    if (definition.integer) {
      schema = schema.int();
    }
    if (definition.positive) {
      schema = schema.positive();
    }
    if (definition.negative) {
      schema = schema.negative();
    }
    
    return schema;
  }
  
  private buildObjectSchema(definition: SchemaDefinition): z.ZodObject<any> {
    const shape: Record<string, z.ZodTypeAny> = {};
    
    if (definition.properties) {
      for (const [key, propDef] of Object.entries(definition.properties)) {
        let propSchema = this.buildSchema(propDef);
        
        if ((propDef as SchemaDefinition).optional) {
          propSchema = propSchema.optional();
        }
        if ((propDef as SchemaDefinition).nullable) {
          propSchema = propSchema.nullable();
        }
        if ((propDef as SchemaDefinition).default !== undefined) {
          propSchema = propSchema.default((propDef as SchemaDefinition).default);
        }
        
        shape[key] = propSchema;
      }
    }
    
    let schema = z.object(shape);
    
    if (!this.options.strict && !definition.strict) {
      schema = schema.passthrough();
    }
    
    if (this.options.stripUnknown || definition.stripUnknown) {
      schema = schema.strict();
    }
    
    return schema;
  }
}

// Schema definition types
interface SchemaDefinition {
  type: 'string' | 'number' | 'boolean' | 'date' | 'array' | 'object' | 
        'union' | 'enum' | 'literal' | 'null' | 'undefined' | 'any';
  
  // Common
  optional?: boolean;
  nullable?: boolean;
  default?: any;
  description?: string;
  
  // String
  min?: number;
  max?: number;
  pattern?: string;
  format?: 'email' | 'url' | 'uuid' | 'cuid' | 'datetime';
  
  // Number
  integer?: boolean;
  positive?: boolean;
  negative?: boolean;
  
  // Array
  items?: SchemaDefinition;
  minItems?: number;
  maxItems?: number;
  
  // Object
  properties?: Record<string, SchemaDefinition>;
  required?: string[];
  strict?: boolean;
  stripUnknown?: boolean;
  
  // Union
  options?: SchemaDefinition[];
  
  // Enum
  values?: readonly string[];
  
  // Literal
  value?: any;
}