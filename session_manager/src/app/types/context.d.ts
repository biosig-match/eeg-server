export type ParsedBodyRecord = Record<string, unknown>;

export type ParsedBody = FormData | ParsedBodyRecord;

declare module 'hono' {
  interface ContextVariableMap {
    parsedBody?: ParsedBody;
  }
}
