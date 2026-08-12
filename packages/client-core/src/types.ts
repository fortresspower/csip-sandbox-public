export type CsipTransportEnvironment = 'deployed' | 'local-test';

export interface CsipTlsMaterial {
  certificate: Uint8Array;
  privateKey: Uint8Array;
  certificateAuthorities: Uint8Array[];
}

export type DnsResolver = (hostname: string) => Promise<string[]>;

export interface CsipTransportOptions {
  baseUrl: string;
  environment: CsipTransportEnvironment;
  tls?: CsipTlsMaterial;
  timeoutMs?: number;
  maxResponseBytes?: number;
  resolveDns?: DnsResolver;
}

export interface CsipResponse {
  status: number;
  headers: Readonly<Record<string, string>>;
  body: string;
}

export interface CsipRequestOptions {
  body?: string;
  headers?: Readonly<Record<string, string>>;
}

export interface CsipTransport {
  readonly origin: string;
  request(method: 'GET' | 'POST' | 'PUT' | 'DELETE', href: string, options?: CsipRequestOptions): Promise<CsipResponse>;
  get(href: string): Promise<CsipResponse>;
  post(href: string, body: string): Promise<CsipResponse>;
  put(href: string, body: string): Promise<CsipResponse>;
  close(): void;
}

export type CsipErrorKind =
  | 'authentication'
  | 'authorization'
  | 'protocol'
  | 'timeout'
  | 'server';

export class CsipError extends Error {
  constructor(
    message: string,
    readonly kind: CsipErrorKind,
    readonly retryable: boolean,
    readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'CsipError';
  }
}

export class CsipConfigurationError extends CsipError {
  constructor(message: string) {
    super(message, 'protocol', false);
    this.name = 'CsipConfigurationError';
  }
}

export class CsipAuthenticationError extends CsipError {
  constructor(message: string, cause?: unknown) {
    super(message, 'authentication', false, cause);
    this.name = 'CsipAuthenticationError';
  }
}

export class CsipAuthorizationError extends CsipError {
  constructor(
    readonly method: string,
    readonly href: string,
    readonly status: number,
    readonly responseBody: string,
  ) {
    super(`${method} ${href} was not authorized (${status})`, 'authorization', false);
    this.name = 'CsipAuthorizationError';
  }
}

export class CsipProtocolError extends CsipError {
  constructor(message: string, readonly status?: number, readonly responseBody?: string) {
    super(message, 'protocol', false);
    this.name = 'CsipProtocolError';
  }
}

export class CsipTimeoutError extends CsipError {
  constructor(
    readonly method: string,
    readonly href: string,
    readonly timeoutMs: number,
  ) {
    super(`${method} ${href} timed out after ${timeoutMs}ms`, 'timeout', true);
    this.name = 'CsipTimeoutError';
  }
}

export class CsipResponseTooLargeError extends CsipProtocolError {
  constructor(
    readonly method: string,
    readonly href: string,
    readonly maxBytes: number,
  ) {
    super(`${method} ${href} response exceeded ${maxBytes} bytes`);
    this.name = 'CsipResponseTooLargeError';
  }
}

export class CsipRetryableServerError extends CsipError {
  constructor(
    readonly method: string,
    readonly href: string,
    readonly status: number,
    readonly responseBody: string,
    cause?: unknown,
  ) {
    super(
      status > 0
        ? `${method} ${href} failed with retryable status ${status}`
        : `${method} ${href} failed before a response was received`,
      'server',
      true,
      cause,
    );
    this.name = 'CsipRetryableServerError';
  }
}
