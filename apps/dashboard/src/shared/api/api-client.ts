import { getDashboardRuntime, RuntimeRequestError } from "../runtime/index.js";
import { parseRelayOperation } from "../runtime/relay-operation.js";
import type { RuntimeResponseV1 } from "../runtime/types.js";

interface ApiErrorBody {
  error?: {
    code?: string;
    message?: string;
  };
}

export class ApiRequestError extends RuntimeRequestError {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
  ) {
    super(status, code, message);
    this.name = "ApiRequestError";
  }
}

function responseJson<T>(response: RuntimeResponseV1): T {
  const body = response.body as (T & ApiErrorBody) | null;
  if (response.status < 200 || response.status >= 300) {
    throw new ApiRequestError(
      response.status,
      body?.error?.code ?? "request_failed",
      body?.error?.message ?? "请求未完成",
    );
  }
  if (!response.json) {
    throw new ApiRequestError(
      response.status,
      "invalid_response",
      "Relay 返回了无法读取的响应",
    );
  }
  return body as T;
}

export async function requestJson<T>(
  path: string,
  options?: RequestInit,
): Promise<T> {
  const operation = parseRelayOperation(path, options);
  const response = await getDashboardRuntime().request(
    operation,
    options?.signal ?? undefined,
  );
  return responseJson<T>(response);
}

export function isCredentialRejected(caught: unknown): caught is ApiRequestError {
  return (
    caught instanceof RuntimeRequestError &&
    caught.status === 401 &&
    caught.code === "unauthorized"
  );
}
