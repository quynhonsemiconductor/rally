import { describe, expect, it, vi } from 'vitest'
import { buildClientResponse, buildProxyRequest, buildUpstreamUrl, proxyToApi } from './proxy'

const API_ORIGIN = 'https://rally-api-dev.qnsc.vn'

describe('buildUpstreamUrl', () => {
  it('keeps the path and query while swapping the origin', () => {
    const result = buildUpstreamUrl(
      'https://rally-dev.qnsc.vn/v1/workspaces?limit=10&cursor=abc',
      API_ORIGIN,
    )
    expect(result).toBe('https://rally-api-dev.qnsc.vn/v1/workspaces?limit=10&cursor=abc')
  })

  it('handles the prefix root with no extra path or query', () => {
    const result = buildUpstreamUrl('https://rally-dev.qnsc.vn/bff/login', API_ORIGIN)
    expect(result).toBe('https://rally-api-dev.qnsc.vn/bff/login')
  })
})

describe('buildProxyRequest', () => {
  it('preserves method and target url', () => {
    const request = new Request('https://rally-dev.qnsc.vn/v1/me', { method: 'GET' })
    const proxied = buildProxyRequest(request, API_ORIGIN)
    expect(proxied.method).toBe('GET')
    expect(proxied.url).toBe('https://rally-api-dev.qnsc.vn/v1/me')
  })

  it('strips the host header and sets forwarding headers from the edge', () => {
    const request = new Request('https://rally-dev.qnsc.vn/v1/me', {
      method: 'GET',
      headers: {
        host: 'rally-dev.qnsc.vn',
        'cf-connecting-ip': '203.0.113.7',
        cookie: '__Host-rova_session=abc',
      },
    })
    const proxied = buildProxyRequest(request, API_ORIGIN)
    expect(proxied.headers.get('host')).toBeNull()
    expect(proxied.headers.get('x-forwarded-for')).toBe('203.0.113.7')
    expect(proxied.headers.get('x-forwarded-proto')).toBe('https')
    expect(proxied.headers.get('x-forwarded-host')).toBe('rally-dev.qnsc.vn')
    // App headers must survive the hop.
    expect(proxied.headers.get('cookie')).toBe('__Host-rova_session=abc')
  })

  it('forwards the CSRF token header', () => {
    // The API rejects a cookie-authenticated write whose X-CSRF-Token is missing,
    // so a future change to the header filter must not drop this one silently.
    const request = new Request('https://rally-dev.qnsc.vn/v1/work-items', {
      method: 'POST',
      headers: {
        'cf-connecting-ip': '203.0.113.7',
        cookie: '__Host-rova_session=abc; __Host-rova_csrf=secret',
        'x-csrf-token': 'tok-1',
        'content-type': 'application/json',
      },
      body: '{}',
    })
    const proxied = buildProxyRequest(request, API_ORIGIN)
    expect(proxied.headers.get('x-csrf-token')).toBe('tok-1')
    expect(proxied.headers.get('cookie')).toBe('__Host-rova_session=abc; __Host-rova_csrf=secret')
  })

  it('drops a client-supplied x-forwarded-for and trusts only cf-connecting-ip', () => {
    const request = new Request('https://rally-dev.qnsc.vn/v1/me', {
      headers: {
        'x-forwarded-for': '198.51.100.1',
        'x-real-ip': '198.51.100.1',
        forwarded: 'for=198.51.100.1',
        'cf-connecting-ip': '203.0.113.7',
      },
    })
    const proxied = buildProxyRequest(request, API_ORIGIN)
    expect(proxied.headers.get('x-forwarded-for')).toBe('203.0.113.7')
    expect(proxied.headers.get('x-real-ip')).toBeNull()
    expect(proxied.headers.get('forwarded')).toBeNull()
  })

  it('drops hop-by-hop headers', () => {
    const request = new Request('https://rally-dev.qnsc.vn/v1/me', {
      headers: { connection: 'keep-alive', 'keep-alive': 'timeout=5' },
    })
    const proxied = buildProxyRequest(request, API_ORIGIN)
    expect(proxied.headers.get('connection')).toBeNull()
    expect(proxied.headers.get('keep-alive')).toBeNull()
  })

  it('forwards a body for non-GET/HEAD methods', () => {
    const request = new Request('https://rally-dev.qnsc.vn/v1/things', {
      method: 'POST',
      body: JSON.stringify({ name: 'x' }),
      headers: { 'content-type': 'application/json' },
    })
    const proxied = buildProxyRequest(request, API_ORIGIN)
    expect(proxied.method).toBe('POST')
    expect(proxied.body).not.toBeNull()
  })
})

describe('buildClientResponse', () => {
  it('preserves status and passes through headers', () => {
    const upstream = new Response('ok', {
      status: 201,
      statusText: 'Created',
      headers: { 'content-type': 'text/plain' },
    })
    const result = buildClientResponse(upstream)
    expect(result.status).toBe(201)
    expect(result.headers.get('content-type')).toBe('text/plain')
  })

  // LIMIT OF THE TEST BELOW, stated because it is easy to over-read: it pins the
  // CONTRACT (two cookies in, two out, values intact) and would catch cookies being
  // dropped, but it does NOT distinguish the per-cookie loop from a naive
  // `new Headers(upstream.headers)` — undici preserves the set-cookie list through the
  // constructor, so that swap keeps this assertion green. The stub-based test further
  // down is the one that actually kills that mutation.
  it('preserves multiple Set-Cookie headers individually', () => {
    const upstream = new Response(null, { status: 204 })
    upstream.headers.append('set-cookie', '__Host-rova_session=abc; Path=/; Secure')
    upstream.headers.append('set-cookie', '__Host-bff_state=; Path=/; Max-Age=0')
    const result = buildClientResponse(upstream)
    const cookies = result.headers.getSetCookie?.() ?? []
    expect(cookies).toHaveLength(2)
    expect(cookies).toContain('__Host-rova_session=abc; Path=/; Secure')
    expect(cookies).toContain('__Host-bff_state=; Path=/; Max-Age=0')
  })

  // The fallback path, and the reason it exists. `getSetCookie` is skipped over in the
  // header loop, so pairing that skip with `?? []` meant a runtime WITHOUT it dropped
  // every cookie: 200 from the API, 200 from the proxy, and no session cookie at the
  // browser — a successful login that presents as an immediate silent logout. Cookies
  // must survive even when the capability does not.
  // The mutation guard, and the reason it cannot use a real Response.
  //
  // Every assertion above passes against a naive `new Headers(upstream.headers)`,
  // because undici carries the set-cookie list through the constructor — so under
  // vitest the defence and its absence are indistinguishable on a real Response. That
  // was a spec claiming a defence it never tested: the swap this file warns about
  // survived the whole suite.
  //
  // A Headers-LIKE stub closes it. It exposes only what the implementation is allowed
  // to rely on — `forEach`, and `getSetCookie` absent, as the Workers runtime
  // historically presented — and is not something `new Headers()` can consume, so the
  // naive version fails here instead of passing quietly. Verified in both directions:
  // green on the per-cookie loop, red on the constructor swap.
  it('rebuilds every Set-Cookie individually, not via the Headers constructor', () => {
    const entries: Array<[string, string]> = [
      ['content-type', 'application/json'],
      ['set-cookie', '__Host-rova_session=abc; Path=/; Secure'],
      ['set-cookie', '__Host-bff_state=; Path=/; Max-Age=0'],
    ]
    const headersLike = {
      forEach(cb: (value: string, key: string) => void) {
        for (const [key, value] of entries) cb(value, key)
      },
      // Deliberately absent, not undefined-by-accident: this is the capability gap.
      getSetCookie: undefined,
    }
    const upstream = {
      body: null,
      status: 204,
      statusText: 'No Content',
      headers: headersLike,
    } as unknown as Response

    const result = buildClientResponse(upstream)

    const cookies = result.headers.getSetCookie?.() ?? []
    expect(cookies).toHaveLength(2)
    expect(cookies).toContain('__Host-rova_session=abc; Path=/; Secure')
    expect(cookies).toContain('__Host-bff_state=; Path=/; Max-Age=0')
    // Non-cookie headers must still make it across.
    expect(result.headers.get('content-type')).toBe('application/json')
  })

  it('still forwards Set-Cookie when the runtime has no getSetCookie', () => {
    const upstream = new Response(null, {
      status: 204,
      headers: { 'set-cookie': '__Host-rova_session=abc; Path=/; Secure' },
    })
    Object.defineProperty(upstream.headers, 'getSetCookie', { value: undefined })

    const result = buildClientResponse(upstream)

    expect(result.headers.get('set-cookie')).toBe('__Host-rova_session=abc; Path=/; Secure')
  })

  it('does not leak the fallback into the normal path', () => {
    // With getSetCookie present the per-cookie list wins, so a cookie is appended once
    // rather than twice — a double-append would corrupt the header.
    const upstream = new Response(null, { status: 204 })
    upstream.headers.append('set-cookie', 'a=1; Path=/')

    const result = buildClientResponse(upstream)

    expect(result.headers.getSetCookie?.() ?? []).toEqual(['a=1; Path=/'])
  })
})

describe('proxyToApi', () => {
  it('returns 500 when the API origin is not configured', async () => {
    const request = new Request('https://rally-dev.qnsc.vn/v1/me')
    const response = await proxyToApi(request, undefined, vi.fn())
    expect(response.status).toBe(500)
  })

  it('forwards the request to the API origin and returns its response', async () => {
    const request = new Request('https://rally-dev.qnsc.vn/v1/me', {
      headers: { 'cf-connecting-ip': '203.0.113.7' },
    })
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response('{"ok":true}', {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    )
    const response = await proxyToApi(request, API_ORIGIN, fetchImpl)

    expect(fetchImpl).toHaveBeenCalledTimes(1)
    const forwarded = fetchImpl.mock.calls[0][0] as Request
    expect(forwarded.url).toBe('https://rally-api-dev.qnsc.vn/v1/me')
    expect(forwarded.headers.get('x-forwarded-for')).toBe('203.0.113.7')
    expect(response.status).toBe(200)
    await expect(response.text()).resolves.toBe('{"ok":true}')
  })
})
