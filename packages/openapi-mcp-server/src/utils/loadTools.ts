import { Tool as MCPTool } from '@modelcontextprotocol/sdk/types.js';
import { OpenAPIV3 } from 'openapi-types';

import { API, HttpMethod } from '@app/types';

import { OpenAPISpec } from './readSpecs';

export type ToolFilters = {
  services?: string[];
  tags?: string[];
  callback?: (spec: OpenAPISpec) => boolean;
};

const SUPPORTED_METHODS = ['get', 'delete', 'post', 'put'];

const VALID_PROPERTY_NAME = /^[a-zA-Z0-9_.-]{1,64}$/;

type Tool = MCPTool & {
  inputSchema: {
    type: 'object';
    properties: Record<
      string,
      {
        type: string;
        description: string;
      }
    >;
    required: string[];
  };
};

type JsonSchema = {
  type: string;
  description: string;
  items?: JsonSchema;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  [key: string]: any; // For other schema properties
};

const trimSlashes = (str: string) => {
  return str.replace(/^\/+|\/+$/g, '');
};

/**
 * Converts an API parameter name into a property name accepted by strict
 * MCP clients (^[a-zA-Z0-9_.-]{1,64}$). e.g. `DateSent<` -> `DateSent_lt`
 * @param name the original parameter name
 */
export function toPropertyName(name: string): string {
  if (VALID_PROPERTY_NAME.test(name)) {
    return name;
  }

  return name
    .replace(/<=/g, '_lte')
    .replace(/>=/g, '_gte')
    .replace(/</g, '_lt')
    .replace(/>/g, '_gt')
    .replace(/[^a-zA-Z0-9_.-]/g, '_')
    .slice(0, 64);
}

function toSchema(
  schema: OpenAPIV3.SchemaObject,
  description?: string,
): JsonSchema {
  const result: JsonSchema = {
    type: schema.type ?? 'string',
    description: description ?? schema.description ?? '',
  };

  // Handle array types
  if (schema.type === 'array' && schema.items) {
    result.items = toSchema(schema.items as OpenAPIV3.SchemaObject);
  }

  // Handle object types
  if (schema.type === 'object' && schema.properties) {
    result.properties = {};
    Object.entries(schema.properties).forEach(([key, value]) => {
      result.properties![key] = toSchema(value as OpenAPIV3.SchemaObject);
    });

    if (schema.required) {
      result.required = schema.required;
    }
  }

  return result;
}

/**
 * Registers a property on the tool, sanitizing its name if needed
 */
function addProperty(
  tool: Tool,
  api: API,
  originalName: string,
  schema: OpenAPIV3.SchemaObject,
  description: string,
): string {
  const propertyName = toPropertyName(originalName);
  let finalDescription = description;
  if (propertyName !== originalName) {
    // eslint-disable-next-line no-param-reassign
    api.paramAliases = { ...api.paramAliases, [propertyName]: originalName };
    finalDescription = `${description} (Original parameter name: ${originalName})`;
  }

  // eslint-disable-next-line no-param-reassign
  tool.inputSchema.properties[propertyName] = toSchema(
    schema,
    finalDescription,
  );

  return propertyName;
}

export default function loadTools(specs: OpenAPISpec[], filters?: ToolFilters) {
  const tools: Map<string, Tool> = new Map();
  const apis: Map<string, API> = new Map();
  const services = filters?.services ?? [];

  specs
    .filter((spec) => spec.document.paths)
    .filter((spec) => {
      if (services.length === 0) {
        return true;
      }

      return services.some((service) => spec.service === service);
    })
    .filter((spec) => {
      if (filters?.callback) {
        return filters.callback(spec);
      }
      return true;
    })
    .forEach((spec) => {
      const { title } = spec.document.info;
      const description =
        spec.document.info.description?.replace(/\.$/, '') ?? '';

      return Object.entries(spec.document.paths).forEach(([path, items]) => {
        if (!items) {
          return;
        }

        const baseURL = items?.servers?.[0]?.url ?? '';

        // eslint-disable-next-line consistent-return
        return Object.entries(items)
          .filter(([method]) => SUPPORTED_METHODS.includes(method.toString()))
          .filter(([, op]) => {
            if (!op) {
              return false;
            }

            const tags = filters?.tags ?? [];
            if (tags.length === 0) {
              return true;
            }
            const operation = op as OpenAPIV3.OperationObject;
            return (operation.tags ?? []).some((tag) => tags.includes(tag));
          })
          .forEach(([method, op]) => {
            const operation = op as OpenAPIV3.OperationObject;

            const name = `${spec.name}--${operation.operationId}`;
            const toolDescription =
              operation.description ||
              `Make a ${method.toUpperCase()} request to ${path}`;

            const tool: Tool = {
              name,
              description: `${title}: ${description}. ${toolDescription}`,
              inputSchema: {
                type: 'object',
                properties: {},
                required: [],
              },
            };
            const api: API = {
              method: method.toUpperCase() as HttpMethod,
              path: `${trimSlashes(baseURL)}/${trimSlashes(path)}`,
              contentType: 'application/json',
            };

            if (operation.parameters) {
              operation.parameters
                .filter((param) => 'name' in param && 'in' in param)
                .forEach((p) => {
                  const param = p as OpenAPIV3.ParameterObject;
                  const schema = param.schema as OpenAPIV3.SchemaObject;

                  const propertyName = addProperty(
                    tool,
                    api,
                    param.name,
                    schema ?? {},
                    param.description || `${param.name} parameter`,
                  );

                  if (param.in === 'query') {
                    api.queryParams = [...(api.queryParams ?? []), param.name];
                  }

                  if (param.required) {
                    tool.inputSchema.required.push(propertyName);
                  }
                });
            }

            const requestBody =
              // @ts-ignore
              operation.requestBody as OpenAPIV3.RequestBodyObject;
            if (requestBody?.content?.['application/x-www-form-urlencoded']) {
              api.contentType = 'application/x-www-form-urlencoded';
            }
            const content =
              requestBody?.content?.['application/x-www-form-urlencoded'] ??
              requestBody?.content?.['application/json'];

            if (content?.schema) {
              const schema = content.schema as OpenAPIV3.SchemaObject;

              if (schema.required) {
                tool.inputSchema.required.push(
                  ...schema.required.map(toPropertyName),
                );
              }

              if (schema.properties) {
                Object.entries(schema.properties).forEach(([key, value]) => {
                  const property = value as OpenAPIV3.SchemaObject;
                  addProperty(
                    tool,
                    api,
                    key,
                    property,
                    property.description ?? `${key} parameter`,
                  );
                });
              }
            }

            tools.set(name, tool);
            apis.set(name, api);
          });
      });
    });

  return { tools, apis };
}
