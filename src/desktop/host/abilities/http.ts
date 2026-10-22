import { lookup } from 'node:dns/promises';
import type { LookupAddress } from 'node:dns';
import { request as nodeRequest } from 'node:https';
import type { IncomingMessage } from 'node:http';
import type { TLSSocket } from 'node:tls';
import {
  AbilityFailure,
  failureCode,
} from '../../../shared/abilities/bridge.js';
import {
  abilityLimits,
  assertBoundedJson,
} from '../../../shared/abilities/limits.js';
import {
  isHttpsUrl,
  permissionSchema,
  validateValue,
} from '../../../shared/abilities/manifest.js';
import { canonicalJson } from '../../../shared/abilities/permissions.js';
import { capabilitySchema } from '../../../shared/abilities/protocol.js';
import type {
  Binding,
  CapabilityReply,
  CapabilityRequest,
  InvocationContext,
} from '../../../shared/abilities/types.js';
import { isPublicAddress } from '../../../shared/network-address.js';

export type AbilityHttpsTransport = {
  lookup(hostname: string): Promise<LookupAddress[]>;
  request: typeof nodeRequest;
};
const defaultTransport: AbilityHttpsTransport = {
  lookup: (hostname) => lookup(hostname, { all: true }),
  request: nodeRequest,
};
type HttpsResponse = {
  status: number;
  headers: { retryAfter?: string; contentType?: string };
  body: string;
};
type HttpsInput = {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: string;
  signal: AbortSignal;
  authorize(): Promise<void>;
};
function waiting<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => {
      signal.removeEventListener('abort', abort);
      reject(new AbilityFailure('cancelled'));
    };
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
    void promise
      .then(resolve, reject)
      .finally(() => signal.removeEventListener('abort', abort));
  });
}
async function deadline<T>(
  signal: AbortSignal,
  action: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const timeout = new AbortController();
  const timer = setTimeout(() => timeout.abort(), abilityLimits.brokerMs);
  timer.unref?.();
  const combined = AbortSignal.any([signal, timeout.signal]);
  try {
    combined.throwIfAborted();
    return await waiting(action(combined), combined);
  } catch (error) {
    if (signal.aborted) throw new AbilityFailure('cancelled');
    if (timeout.signal.aborted) throw new AbilityFailure('timeout');
    throw error instanceof AbilityFailure
      ? error
      : new AbilityFailure('provider_error');
  } finally {
    clearTimeout(timer);
  }
}
async function responseBody(response: IncomingMessage): Promise<HttpsResponse> {
  const status = response.statusCode ?? 0;
  if (status < 200 || status > 599 || (status >= 300 && status < 400)) {
    response.destroy();
    throw new AbilityFailure('provider_error');
  }
  const encoding = response.headers['content-encoding'];
  const length = response.headers['content-length'];
  if (
    (encoding && encoding !== 'identity') ||
    (length !== undefined &&
      (!/^\d+$/.test(length) || Number(length) > abilityLimits.responseBytes))
  ) {
    response.destroy();
    throw new AbilityFailure('invalid_response');
  }
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of response) {
    bytes += chunk.length;
    if (bytes > abilityLimits.responseBytes) {
      response.destroy();
      throw new AbilityFailure('invalid_response');
    }
    chunks.push(Buffer.from(chunk));
  }
  const headers: HttpsResponse['headers'] = {};
  for (const [source, target, limit] of [
    ['retry-after', 'retryAfter', 64],
    ['content-type', 'contentType', 128],
  ] as const) {
    const value = response.headers[source];
    if (
      typeof value === 'string' &&
      value.length <= limit &&
      ![...value].some((char) => char.charCodeAt(0) < 32)
    )
      headers[target] = value;
  }
  let body: string;
  try {
    body = new TextDecoder('utf-8', { fatal: true }).decode(
      Buffer.concat(chunks),
    );
  } catch {
    throw new AbilityFailure('invalid_response');
  }
  return { status, headers, body };
}

/** Host-internal transport, also used for OAuth exchanges. No redirect or proxy path. */
export async function requestAbilityHttps(
  input: HttpsInput,
  transport: AbilityHttpsTransport = defaultTransport,
): Promise<HttpsResponse> {
  return deadline(input.signal, async (signal) => {
    if (
      !isHttpsUrl(input.url) ||
      (input.body && Buffer.byteLength(input.body) > abilityLimits.frameBytes)
    )
      throw new AbilityFailure('permission_denied');
    const url = new URL(input.url);
    await waiting(input.authorize(), signal);
    const addresses = await waiting(transport.lookup(url.hostname), signal);
    if (
      !addresses.length ||
      addresses.some(
        (value) =>
          ![4, 6].includes(value.family) || !isPublicAddress(value.address),
      )
    )
      throw new AbilityFailure('permission_denied');
    // Copy the selected address; neither another lookup nor a mutated answer
    // object can redirect the connection between review and the TLS handshake.
    const destination = { ...addresses[0] };
    await waiting(input.authorize(), signal);
    signal.throwIfAborted();
    return await new Promise<HttpsResponse>((resolve, reject) => {
      const request = transport.request(
        url,
        {
          agent: false,
          signal,
          method: input.method,
          servername: url.hostname,
          rejectUnauthorized: true,
          headers: {
            ...input.headers,
            'Accept-Encoding': 'identity',
            ...(input.body !== undefined
              ? { 'Content-Length': String(Buffer.byteLength(input.body)) }
              : {}),
          },
          lookup: (_hostname, options, callback) => {
            if (options.all) callback(null, [{ ...destination }]);
            else callback(null, destination.address, destination.family);
          },
        },
        (response) => {
          void responseBody(response).then(resolve, reject);
        },
      );
      request.once('error', reject);
      let writing = false;
      request.once('socket', (socket) => {
        const secured = socket as TLSSocket;
        const write = () => {
          if (writing) return;
          writing = true;
          void waiting(input.authorize(), signal)
            .then(() => {
              signal.throwIfAborted();
              if (!secured.authorized)
                throw new AbilityFailure('provider_error');
              request.end(input.body);
            })
            .catch((error: unknown) => {
              const failure =
                error instanceof AbilityFailure
                  ? error
                  : new AbilityFailure('permission_denied');
              request.destroy(failure);
              reject(failure);
            });
        };
        secured.once('secureConnect', write);
        if (!secured.connecting && secured.authorized) write();
      });
    });
  });
}

export class AbilityHttp {
  constructor(
    private readonly options: {
      authorize(context: InvocationContext): Promise<Binding>;
      credential(
        context: InvocationContext,
        ruleId: string,
        signal: AbortSignal,
        rejectedToken?: string,
      ): Promise<string>;
      transport?: AbilityHttpsTransport;
    },
  ) {}
  async request(
    context: InvocationContext,
    input: CapabilityRequest & { kind: 'https' },
    signal: AbortSignal,
  ): Promise<CapabilityReply> {
    try {
      return await deadline(signal, async (signal) => {
        let request: Extract<CapabilityRequest, { kind: 'https' }>;
        try {
          assertBoundedJson(input, abilityLimits.frameBytes);
          const parsed = capabilitySchema.parse(input);
          if (parsed.kind !== 'https') throw new Error('Unexpected capability');
          request = parsed;
        } catch {
          throw new AbilityFailure('permission_denied');
        }
        let identity: string | undefined;
        const authorize = async () => {
          let binding: Binding;
          try {
            binding = await waiting(this.options.authorize(context), signal);
          } catch (error) {
            throw error instanceof AbilityFailure
              ? error
              : new AbilityFailure('permission_denied');
          }
          if (
            !binding.enabled ||
            binding.restored ||
            binding.id !== context.bindingId ||
            binding.dotId !== context.dotId ||
            binding.digest !== context.digest ||
            binding.revision !== context.grantRevision ||
            !binding.grants.includes(request.ruleId)
          )
            throw new AbilityFailure('permission_denied');
          const permission = binding.manifest.permissions.find(
            (p) => p.id === request.ruleId,
          );
          const parsed = permissionSchema.safeParse(permission);
          if (!parsed.success || parsed.data.kind !== 'https')
            throw new AbilityFailure('permission_denied');
          const rule = parsed.data;
          if (rule.account) {
            const account = binding.manifest.permissions.find(
              (p) => p.id === rule.account,
            );
            if (
              account?.kind !== 'oauth' ||
              !binding.grants.includes(account.id) ||
              account.resourceOrigin !== rule.origin
            )
              throw new AbilityFailure('permission_denied');
          }
          const current = canonicalJson(rule);
          if (identity && identity !== current)
            throw new AbilityFailure('permission_denied');
          identity = current;
          return rule;
        };
        const rule = await authorize();
        try {
          validateValue(rule.pathValues, request.pathValues);
          validateValue(rule.query, request.query);
          if (rule.body) validateValue(rule.body, request.body);
          else if (request.body !== undefined)
            throw new Error('No body permitted');
          if (rule.method === 'GET' && request.body !== undefined)
            throw new Error('GET body not supported');
        } catch {
          throw new AbilityFailure('permission_denied');
        }
        const url = new URL(rule.origin);
        url.pathname =
          '/' +
          rule.path
            .map((segment) =>
              encodeURIComponent(
                typeof segment === 'string'
                  ? segment
                  : request.pathValues[segment.param],
              ),
            )
            .join('/');
        for (const [key, value] of Object.entries(request.query))
          url.searchParams.set(
            key,
            typeof value === 'string' ? value : canonicalJson(value),
          );
        const headers: Record<string, string> = {
          Accept: 'application/json',
          'User-Agent': 'My-Own-Dots-Ability-Host',
        };
        let credential: string | undefined;
        const credentials: string[] = [];
        const authenticate = async (rejectedToken?: string) => {
          credential = await waiting(
            this.options.credential(context, rule.id, signal, rejectedToken),
            signal,
          );
          if (
            typeof credential !== 'string' ||
            credential.length > 16_384 ||
            !/^[A-Za-z0-9._~+/-]+=*$/.test(credential)
          )
            throw new AbilityFailure('setup_needed');
          credentials.push(credential);
          headers.Authorization = `Bearer ${credential}`;
        };
        if (rule.account) await authenticate();
        const body =
          request.body === undefined ? undefined : JSON.stringify(request.body);
        if (body !== undefined) headers['Content-Type'] = 'application/json';
        const send = () =>
          requestAbilityHttps(
            {
              url: url.href,
              method: rule.method,
              headers: { ...headers },
              body,
              signal,
              authorize: async () => {
                await authorize();
              },
            },
            this.options.transport,
          );
        let response = await send();
        if (response.status === 401 && rule.account) {
          // A confirmed authentication rejection permits one retry. Never replay
          // an unknown delivery, timeout or server error.
          await authorize();
          signal.throwIfAborted();
          await authenticate(credential);
          response = await send();
        }
        await authorize();
        signal.throwIfAborted();
        // Defend against ordinary provider diagnostics echoing the bearer token.
        // An authorized provider intentionally encoding its own token is outside
        // this boundary; token endpoints are never available to workers.
        if (
          credentials.some(
            (token) =>
              response.body.includes(token) ||
              Object.values(response.headers).some((value) =>
                value.includes(token),
              ),
          )
        )
          throw new AbilityFailure('invalid_response');
        return { ok: true, kind: 'https', ...response };
      });
    } catch (error) {
      return { ok: false, code: failureCode(error) };
    }
  }
}
