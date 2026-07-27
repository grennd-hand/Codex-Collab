interface ApiErrorBody {
  error?: {
    code?: string;
    message?: string;
  };
}

type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export class ApiRequestError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ApiRequestError";
  }
}

export async function requestJson<T>(
  path: string,
  options?: RequestInit,
  fetcher: FetchLike = fetch,
): Promise<T> {
  const response = await fetcher(path, options);
  let body: (T & ApiErrorBody) | null = null;
  try {
    body = (await response.json()) as T & ApiErrorBody;
  } catch {
    if (response.ok) {
      throw new ApiRequestError(
        response.status,
        "invalid_response",
        "Relay 返回了无法读取的响应",
      );
    }
  }
  if (!response.ok) {
    throw new ApiRequestError(
      response.status,
      body?.error?.code ?? "request_failed",
      body?.error?.message ?? "请求未完成",
    );
  }
  return body as T;
}

export function isCredentialRejected(caught: unknown): caught is ApiRequestError {
  return (
    caught instanceof ApiRequestError &&
    caught.status === 401 &&
    caught.code === "unauthorized"
  );
}
