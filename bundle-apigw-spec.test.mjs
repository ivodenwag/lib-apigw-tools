import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { buildPrefixedPaths } from './bundle-apigw-spec.mjs'

const OPTIONS = {
  pathPrefix: '/identity/v1',
  nlbDns: 'test-nlb.internal.example.com',
  nlbPort: '3010',
  serviceApiPrefix: '/api/v1',
  vpcLinkId: 'abc123',
}

describe('buildPrefixedPaths', () => {
  it('prefixes all paths with the path prefix', () => {
    const spec = {
      paths: {
        '/health': { get: { responses: { 200: {} } } },
        '/users': { get: { responses: { 200: {} } } },
      },
    }

    const result = buildPrefixedPaths(spec, OPTIONS)

    assert.ok(result['/identity/v1/health'], 'should have /identity/v1/health')
    assert.ok(result['/identity/v1/users'], 'should have /identity/v1/users')
    assert.equal(Object.keys(result).length, 2)
  })

  it('adds x-amazon-apigateway-integration to each HTTP method', () => {
    const spec = {
      paths: {
        '/users': {
          get: { responses: { 200: {} } },
          post: { responses: { 201: {} } },
        },
      },
    }

    const result = buildPrefixedPaths(spec, OPTIONS)
    const pathItem = result['/identity/v1/users']

    assert.ok(pathItem.get['x-amazon-apigateway-integration'], 'GET should have integration')
    assert.ok(pathItem.post['x-amazon-apigateway-integration'], 'POST should have integration')
  })

  it('sets correct integration URI with NLB target', () => {
    const spec = {
      paths: {
        '/health': { get: { responses: { 200: {} } } },
      },
    }

    const result = buildPrefixedPaths(spec, OPTIONS)
    const integration = result['/identity/v1/health'].get['x-amazon-apigateway-integration']

    assert.equal(integration.type, 'HTTP_PROXY')
    assert.equal(integration.httpMethod, 'GET')
    assert.equal(integration.uri, 'http://test-nlb.internal.example.com:3010/api/v1/health')
    assert.equal(integration.connectionType, 'VPC_LINK')
    assert.equal(integration.connectionId, 'abc123')
  })

  it('maps path parameters to requestParameters', () => {
    const spec = {
      paths: {
        '/users/{id}': { get: { responses: { 200: {} } } },
        '/families/{familyId}/members/{memberId}': { delete: { responses: { 204: {} } } },
      },
    }

    const result = buildPrefixedPaths(spec, OPTIONS)

    const singleParam = result['/identity/v1/users/{id}'].get['x-amazon-apigateway-integration']
    assert.deepEqual(singleParam.requestParameters, {
      'integration.request.path.id': 'method.request.path.id',
    })

    const multiParam =
      result['/identity/v1/families/{familyId}/members/{memberId}'].delete[
        'x-amazon-apigateway-integration'
      ]
    assert.deepEqual(multiParam.requestParameters, {
      'integration.request.path.familyId': 'method.request.path.familyId',
      'integration.request.path.memberId': 'method.request.path.memberId',
    })
  })

  it('omits requestParameters when path has no parameters', () => {
    const spec = {
      paths: {
        '/health': { get: { responses: { 200: {} } } },
      },
    }

    const result = buildPrefixedPaths(spec, OPTIONS)
    const integration = result['/identity/v1/health'].get['x-amazon-apigateway-integration']

    assert.equal(integration.requestParameters, undefined)
  })

  it('returns empty object for spec with no paths', () => {
    const result = buildPrefixedPaths({ paths: {} }, OPTIONS)
    assert.deepEqual(result, {})
  })

  it('returns empty object when paths key is missing', () => {
    const result = buildPrefixedPaths({}, OPTIONS)
    assert.deepEqual(result, {})
  })

  it('handles all supported HTTP methods', () => {
    const spec = {
      paths: {
        '/resource': {
          get: { responses: { 200: {} } },
          post: { responses: { 201: {} } },
          put: { responses: { 200: {} } },
          patch: { responses: { 200: {} } },
          delete: { responses: { 204: {} } },
          head: { responses: { 200: {} } },
          options: { responses: { 200: {} } },
        },
      },
    }

    const result = buildPrefixedPaths(spec, OPTIONS)
    const pathItem = result['/identity/v1/resource']

    for (const method of ['get', 'post', 'put', 'patch', 'delete', 'head', 'options']) {
      assert.ok(
        pathItem[method]['x-amazon-apigateway-integration'],
        `${method} should have integration`,
      )
      assert.equal(
        pathItem[method]['x-amazon-apigateway-integration'].httpMethod,
        method.toUpperCase(),
      )
    }
  })

  it('uses custom PATH_PREFIX when provided', () => {
    const spec = {
      paths: {
        '/health': { get: { responses: { 200: {} } } },
      },
    }

    const result = buildPrefixedPaths(spec, { ...OPTIONS, pathPrefix: '/cook/v2' })

    assert.ok(result['/cook/v2/health'], 'should use custom prefix')
    assert.equal(Object.keys(result).length, 1)
  })
})
