import type { ClientRequest, ServerResponse } from 'http';

/**
 * @param {{
 *   request: import('http').IncomingMessage;
 *   base: string;
 *   bodySizeLimit?: number;
 * }} options
 * @returns {Promise<Request>}
 */
export async function getRequest({
  request,
  base,
  bodySizeLimit,
}: {
  request: ClientRequest;
  base: string;
  bodySizeLimit?: number;
}) {
  return new Request(base + request.req.url, {
    // @ts-expect-error
    duplex: 'half',
    method: request.method,
    headers: /** @type {Record<string, string>} */ request.headers,
    body: getRawBody(request, bodySizeLimit),
  });
}
export class HttpError {
  /**
   * @param {number} status
   * @param {{message: string} extends App.Error ? (App.Error | string | undefined) : App.Error} body
   */
  constructor(public status: number, public body: { message: string }) {
    this.status = status;
    if (typeof body === 'string') {
      this.body = { message: body };
    } else if (body) {
      this.body = body;
    } else {
      this.body = { message: `Error: ${status}` };
    }
  }

  toString() {
    return JSON.stringify(this.body);
  }
}

/**
 * Creates an `HttpError` object with an HTTP status code and an optional message.
 * This object, if thrown during request handling, will cause SvelteKit to
 * return an error response without invoking `handleError`.
 * Make sure you're not catching the thrown error, which would prevent SvelteKit from handling it.
 * @param {number} status The [HTTP status code](https://developer.mozilla.org/en-US/docs/Web/HTTP/Status#client_error_responses). Must be in the range 400-599.
 * @param {{ message: string } extends App.Error ? App.Error | string | undefined : never} body An object that conforms to the App.Error type. If a string is passed, it will be used as the message property.
 */
export function error(status: number, body: { message: string }) {
  return new HttpError(status, body);
}

/**
 * @param {import('http').IncomingMessage} req
 * @param {number} [bodySizeLimit]
 */
function getRawBody(req: ClientRequest, bodySizeLimit?: number) {
  const h = req.headers;

  if (!h.get('content-type')) {
    return null;
  }

  const contentLength = Number(h.get('content-length'));

  // check if no request body
  if ((isNaN(contentLength) && h.get('transfer-encoding') == null) || contentLength === 0) {
    return null;
  }

  let length = contentLength;

  if (bodySizeLimit) {
    if (!length) {
      length = bodySizeLimit;
    } else if (length > bodySizeLimit) {
      throw error(413, {
        message: `Received content-length of ${length}, but only accept up to ${bodySizeLimit} bytes.`,
      });
    }
  }

  if (req.destroyed) {
    const readable = new ReadableStream();
    readable.cancel();
    return readable;
  }

  let size = 0;
  let cancelled = false;

  return new ReadableStream({
    start(controller) {
      req.on('error', (error) => {
        cancelled = true;
        controller.error(error);
      });

      req.on('end', () => {
        if (cancelled) return;
        controller.close();
      });

      req.on('data', (chunk) => {
        if (cancelled) return;

        size += chunk.length;
        if (size > length) {
          cancelled = true;
          controller.error(
            error(413, {
              message: `request body size exceeded ${
                contentLength ? "'content-length'" : 'BODY_SIZE_LIMIT'
              } of ${length}`,
            })
          );
          return;
        }

        controller.enqueue(chunk);

        if (controller.desiredSize === null || controller.desiredSize <= 0) {
          req.pause();
        }
      });
    },

    pull() {
      req.resume();
    },

    cancel(reason) {
      cancelled = true;
      req.destroy(reason);
    },
  });
}

/**
 * @param {import('http').ServerResponse} res
 * @param {Response} response
 * @returns {Promise<void>}
 */
export async function setResponse(res: ServerResponse, response: Response) {
  response.headers.forEach((value, key) => {
    try {
      res.setHeader(key, value);
    } catch (error) {
      res.getHeaderNames().forEach((name) => res.removeHeader(name));
      res.writeHead(500).end(String(error));
      return;
    }
  });

  res.writeHead(response.status);

  if (!response.body) {
    res.end();
    return;
  }

  if (response.body.locked) {
    res.end(
      'Fatal error: Response body is locked. ' +
        "This can happen when the response was already read (for example through 'response.json()' or 'response.text()')."
    );
    return;
  }

  const reader = response.body.getReader();

  if (res.destroyed) {
    reader.cancel();
    return;
  }

  const cancel = (error: Error) => {
    res.off('close', cancel);
    res.off('error', cancel);

    // If the reader has already been interrupted with an error earlier,
    // then it will appear here, it is useless, but it needs to be catch.
    reader.cancel(error).catch(() => {});
    if (error) res.destroy(error);
  };

  res.on('close', cancel);
  res.on('error', cancel);

  next();
  async function next() {
    try {
      for (;;) {
        const { done, value } = await reader.read();

        if (done) break;

        if (!res.write(value)) {
          res.once('drain', next);
          return;
        }
      }
      res.end();
    } catch (error) {
      cancel(error instanceof Error ? error : new Error(String(error)));
    }
  }
}
