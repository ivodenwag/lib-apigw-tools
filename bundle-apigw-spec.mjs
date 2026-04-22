#!/usr/bin/env node
/**
 * Bundle OpenAPI spec for AWS API Gateway import.
 *
 * Resolves all $ref splits in a service's openapi.yaml, prefixes all paths
 * with the service path prefix, adds x-amazon-apigateway-integration
 * extensions, and uploads the result to S3.
 *
 * Required env vars:
 *   SERVICE_NAME   — Service identifier (e.g. "identity", "cook")
 *   NLB_DNS        — Internal NLB DNS name
 *   VPC_LINK_ID    — API Gateway VPC Link ID
 *
 * Optional env vars:
 *   PATH_PREFIX    — API Gateway path prefix (default: /${SERVICE_NAME}/v1)
 *   NLB_PORT       — NLB port the service listens on (default: 3010)
 *   SERVICE_API_PREFIX — Service-internal API prefix (default: /api/v1)
 *   OPENAPI_SPEC   — Path to openapi.yaml (default: app/api/openapi.yaml, relative to cwd)
 *   S3_BUCKET      — S3 bucket for spec upload (default: tec42-terraform-state)
 *   S3_KEY_PREFIX  — S3 key prefix (default: api-gateway-specs)
 *   DRY_RUN        — If set, write to stdout only (no S3 upload)
 */

import { execSync } from 'node:child_process'
import { readFileSync, writeFileSync, mkdirSync, unlinkSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

// --- Validate required env vars ---
const SERVICE_NAME = process.env.SERVICE_NAME
const NLB_DNS = process.env.NLB_DNS
const VPC_LINK_ID = process.env.VPC_LINK_ID

const missing = ['SERVICE_NAME', 'NLB_DNS', 'VPC_LINK_ID'].filter((k) => !process.env[k])
if (missing.length > 0) {
  console.error(`❌ Missing required env vars: ${missing.join(', ')}`)
  process.exit(1)
}

// --- Optional env vars with defaults ---
const PATH_PREFIX = process.env.PATH_PREFIX ?? `/${SERVICE_NAME}/v1`
const NLB_PORT = process.env.NLB_PORT ?? '3010'
const SERVICE_API_PREFIX = process.env.SERVICE_API_PREFIX ?? '/api/v1'
const OPENAPI_SPEC = process.env.OPENAPI_SPEC ?? 'app/api/openapi.yaml'
const S3_BUCKET = process.env.S3_BUCKET ?? 'tec42-terraform-state'
const S3_KEY_PREFIX = process.env.S3_KEY_PREFIX ?? 'api-gateway-specs'
const DRY_RUN = !!process.env.DRY_RUN

const cwd = process.cwd()
const specPath = resolve(cwd, OPENAPI_SPEC)

if (!existsSync(specPath)) {
  console.error(`❌ OpenAPI spec not found: ${specPath}`)
  process.exit(1)
}

console.log(`🚀 Bundling OpenAPI spec for service: ${SERVICE_NAME}`)
console.log(`   Spec:       ${specPath}`)
console.log(`   Prefix:     ${PATH_PREFIX}`)
console.log(`   NLB target: http://${NLB_DNS}:${NLB_PORT}${SERVICE_API_PREFIX}`)
if (DRY_RUN) console.log('   Mode:       DRY RUN (no S3 upload)')

// --- Step 1: Bundle OpenAPI spec (resolve all $refs via redocly) ---
const tmpBundled = join(tmpdir(), `openapi-bundled-${Date.now()}.json`)

console.log('\n📦 Bundling $refs...')

// Find redocly binary: prefer local node_modules, fallback to npx
const redoclyLocal = resolve(cwd, 'node_modules/.bin/redocly')
const redoclyCmd = existsSync(redoclyLocal)
  ? `${redoclyLocal} bundle ${OPENAPI_SPEC} -o ${tmpBundled}`
  : `npx @redocly/cli bundle ${OPENAPI_SPEC} -o ${tmpBundled}`

execSync(redoclyCmd, { cwd, stdio: 'inherit' })

const spec = JSON.parse(readFileSync(tmpBundled, 'utf-8'))
unlinkSync(tmpBundled)

// --- Step 2: Prefix all paths + add x-amazon-apigateway-integration ---
const HTTP_METHODS = ['get', 'post', 'put', 'patch', 'delete', 'head', 'options']

const prefixedPaths = {}

for (const [path, pathItem] of Object.entries(spec.paths ?? {})) {
  const prefixedPath = `${PATH_PREFIX}${path}`

  // Extract path parameter names, e.g. {id}, {familyId}
  const pathParams = [...path.matchAll(/\{(\w+)\}/g)].map((m) => m[1])

  for (const method of HTTP_METHODS) {
    if (!pathItem[method]) continue

    const requestParameters = {}
    for (const param of pathParams) {
      requestParameters[`integration.request.path.${param}`] = `method.request.path.${param}`
    }

    pathItem[method]['x-amazon-apigateway-integration'] = {
      type: 'HTTP_PROXY',
      httpMethod: method.toUpperCase(),
      uri: `http://${NLB_DNS}:${NLB_PORT}${SERVICE_API_PREFIX}${path}`,
      connectionType: 'VPC_LINK',
      connectionId: VPC_LINK_ID,
      ...(Object.keys(requestParameters).length > 0 ? { requestParameters } : {}),
    }
  }

  prefixedPaths[prefixedPath] = pathItem
}

spec.paths = prefixedPaths

const pathCount = Object.keys(prefixedPaths).length
console.log(`\n✅ ${pathCount} paths prefixed with ${PATH_PREFIX}`)

// --- Step 3: Output ---
const outputJson = JSON.stringify(spec, null, 2)

if (DRY_RUN) {
  const tmpOut = join(tmpdir(), `openapi-apigw-${SERVICE_NAME}-${Date.now()}.json`)
  writeFileSync(tmpOut, outputJson, 'utf-8')
  console.log(`\n🔍 DRY RUN — written to: ${tmpOut}`)
  process.exit(0)
}

// --- Step 4: Upload to S3 ---
const s3Key = `${S3_KEY_PREFIX}/${SERVICE_NAME}.json`
const s3Uri = `s3://${S3_BUCKET}/${s3Key}`

// Write to temp file for upload
const tmpUpload = join(tmpdir(), `openapi-apigw-${SERVICE_NAME}-upload-${Date.now()}.json`)
writeFileSync(tmpUpload, outputJson, 'utf-8')

console.log(`\n☁️  Uploading to ${s3Uri}...`)

try {
  execSync(`aws s3 cp ${tmpUpload} ${s3Uri} --content-type application/json`, {
    stdio: 'inherit',
  })
  console.log(`✅ Uploaded: ${s3Uri}`)
} finally {
  unlinkSync(tmpUpload)
}
