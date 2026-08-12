import {
  CsipRetryableServerError,
  type CsipRequestOptions,
  type CsipResponse,
  type CsipTransport,
} from '../src/index.js';

export interface RecordedRequest {
  method: string;
  href: string;
  body?: string;
}

export class MemoryTransport implements CsipTransport {
  readonly origin = 'https://partner.example';
  readonly requests: RecordedRequest[] = [];
  readonly getBodies = new Map<string, () => string>();
  failNextGet = false;
  failNextPost = false;
  failNextPostWith?: Error;

  request(
    method: 'GET' | 'POST' | 'PUT' | 'DELETE',
    href: string,
    options: CsipRequestOptions = {},
  ): Promise<CsipResponse> {
    const path = new URL(href, this.origin).pathname;
    this.requests.push({ method, href: path, ...(options.body !== undefined ? { body: options.body } : {}) });
    if (method === 'GET') {
      if (this.failNextGet) {
        this.failNextGet = false;
        return Promise.reject(new CsipRetryableServerError(method, path, 503, 'unavailable'));
      }
      const body = this.getBodies.get(path)?.();
      if (body === undefined) return Promise.reject(new Error(`no fixture for ${path}`));
      return Promise.resolve({ status: 200, headers: {}, body });
    }
    if (method === 'POST' && this.failNextPost) {
      this.failNextPost = false;
      return Promise.reject(new CsipRetryableServerError(method, path, 503, 'unavailable'));
    }
    if (method === 'POST' && this.failNextPostWith) {
      const error = this.failNextPostWith;
      this.failNextPostWith = undefined;
      return Promise.reject(error);
    }
    return Promise.resolve({ status: method === 'POST' ? 201 : 204, headers: {}, body: '' });
  }

  get(href: string): Promise<CsipResponse> {
    return this.request('GET', href);
  }

  post(href: string, body: string): Promise<CsipResponse> {
    return this.request('POST', href, { body });
  }

  put(href: string, body: string): Promise<CsipResponse> {
    return this.request('PUT', href, { body });
  }

  close(): void {}
}

export const controlXml = (options: {
  mRID: string;
  fixedW: number;
  currentStatus?: number;
  responseRequired?: string;
  replyTo?: string;
  pollRate?: number;
}): string => `<?xml version="1.0"?><DERControlList xmlns="urn:ieee:std:2030.5:ns" all="1" results="1"${options.pollRate === undefined ? '' : ` pollRate="${options.pollRate}"`}>
  <DERControl href="/events/${options.mRID}"${options.replyTo ? ` replyTo="${options.replyTo}"` : ''}${options.responseRequired ? ` responseRequired="${options.responseRequired}"` : ''}>
    <mRID>${options.mRID}</mRID><creationTime>100</creationTime>
    <EventStatus><currentStatus>${options.currentStatus ?? 0}</currentStatus></EventStatus>
    <interval><start>200</start><duration>300</duration></interval>
    <DERControlBase><opModFixedW>${options.fixedW}</opModFixedW></DERControlBase>
  </DERControl>
</DERControlList>`;
