export type HttpMethod = 'GET' | 'DELETE' | 'POST' | 'PUT';
export type ContentType =
  | 'application/json'
  | 'application/x-www-form-urlencoded'
  | 'multipart/form-data';

export type API = {
  method: HttpMethod;
  path: string;
  contentType: ContentType;
  /**
   * Original names of the parameters declared `in: query`.
   * They are appended to the URL for GET/DELETE requests.
   */
  queryParams?: string[];
  /**
   * Map of exposed (sanitized) property name -> original API parameter name.
   */
  paramAliases?: Record<string, string>;
};
