interface RelayErrorBody {
  error?: {
    code?: string;
    message?: string;
  };
}

export class RelayRequestError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "RelayRequestError";
  }
}

export class RelayHttpTransport {
  constructor(private readonly baseUrl: string) {}

  async requestBytes(
    path: string,
    headers: HeadersInit = {},
  ): Promise<Uint8Array> {
    const response = await fetch(new URL(path, this.baseUrl), {
      headers,
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) {
      const body = (await response.json()) as RelayErrorBody;
      throw new Error(
        body.error?.message ??
          `Relay attachment request failed with ${response.status}`,
      );
    }
    return new Uint8Array(await response.arrayBuffer());
  }

  async request<T = Record<string, unknown>>(
    path: string,
    init: RequestInit = {},
  ): Promise<T> {
    const response = await fetch(new URL(path, this.baseUrl), {
      ...init,
      headers: {
        "content-type": "application/json",
        ...init.headers,
      },
      signal: AbortSignal.timeout(15_000),
    });
    const body = (await response.json()) as T & RelayErrorBody;
    if (!response.ok) {
      throw new RelayRequestError(
        response.status,
        body.error?.code ?? "request_failed",
        body.error?.message ?? `Relay request failed with ${response.status}`,
      );
    }
    return body;
  }
}
