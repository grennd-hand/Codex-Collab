import { readFile } from "node:fs/promises";
import { DESKTOP_CSP, resolveDesktopAsset } from "./security-policy.js";

function rejectedResponse(status = 404): Response {
  return new Response("Not found", {
    status,
    headers: {
      "cache-control": "no-store",
      "content-type": "text/plain; charset=utf-8",
      "content-security-policy": DESKTOP_CSP,
      "x-content-type-options": "nosniff",
    },
  });
}

export function createDesktopProtocolHandler(rendererRoot: string) {
  return async (request: Request): Promise<Response> => {
    try {
      const asset = resolveDesktopAsset(request.url, request.method, rendererRoot);
      const body = await readFile(asset.absolutePath);
      const responseBody = body.buffer.slice(
        body.byteOffset,
        body.byteOffset + body.byteLength,
      ) as ArrayBuffer;
      return new Response(responseBody, {
        status: 200,
        headers: {
          "cache-control": asset.cacheControl,
          "content-type": asset.contentType,
          "content-security-policy": DESKTOP_CSP,
          "cross-origin-opener-policy": "same-origin",
          "cross-origin-resource-policy": "same-origin",
          "permissions-policy":
            "camera=(), microphone=(), geolocation=(), display-capture=(), usb=(), serial=()",
          "referrer-policy": "no-referrer",
          "x-content-type-options": "nosniff",
          "x-frame-options": "DENY",
        },
      });
    } catch {
      return rejectedResponse();
    }
  };
}
