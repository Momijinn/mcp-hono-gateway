import { readFile } from 'node:fs/promises'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import exifr from 'exifr'
import { z } from 'zod'

const InputSchema = z
  .object({
    path: z.string().min(1).optional(),
    base64: z.string().min(1).optional(),
    dataUrl: z.string().min(1).optional(),
    url: z
      .string()
      .min(1)
      .refine((v) => {
        try {
          const u = new URL(v)
          return u.protocol === 'http:' || u.protocol === 'https:'
        } catch {
          return false
        }
      }, 'url must be a valid http(s) URL')
      .optional(),
    bytes: z.array(z.number().int().min(0).max(255)).min(1).optional(),
    headers: z.record(z.string(), z.string()).optional(),
    timeoutMs: z.number().int().min(1).max(120_000).optional().default(15_000),
    maxBytes: z.number().int().min(1).max(50_000_000).optional().default(10_000_000),
    includeBinary: z.boolean().optional().default(false),
  })
  .refine(
    (v) => {
      const n = [v.path, v.base64, v.dataUrl, v.url, v.bytes].filter((x) => x !== undefined).length
      return n === 1
    },
    {
      message: 'Exactly one of path, base64, dataUrl, url, or bytes is required',
    },
  )

type ToolInput = z.infer<typeof InputSchema>

const OutputSchema = z.object({
  hasExif: z.boolean(),
  tagCount: z.number().int().min(0),
  tags: z.record(z.string(), z.any()),
})

const stripDataUrlPrefix = (dataUrl: string) => {
  const idx = dataUrl.indexOf(',')
  if (idx === -1) return dataUrl
  return dataUrl.slice(idx + 1)
}

const fetchToBuffer = async (
  url: string,
  opts: { headers?: Record<string, string>; timeoutMs: number; maxBytes: number },
) => {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs)

  try {
    const res = await fetch(url, {
      headers: opts.headers,
      signal: controller.signal,
    })

    if (!res.ok) {
      throw new Error(`Fetch failed: ${res.status} ${res.statusText}`)
    }

    const contentLength = res.headers.get('content-length')
    if (contentLength) {
      const n = Number(contentLength)
      if (Number.isFinite(n) && n > opts.maxBytes) {
        throw new Error(`Response too large: content-length=${n} (maxBytes=${opts.maxBytes})`)
      }
    }

    if (!res.body) {
      const ab = await res.arrayBuffer()
      if (ab.byteLength > opts.maxBytes) {
        throw new Error(`Response too large: ${ab.byteLength} bytes (maxBytes=${opts.maxBytes})`)
      }
      return Buffer.from(ab)
    }

    const reader = res.body.getReader()
    const chunks: Uint8Array[] = []
    let received = 0
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      received += value.byteLength
      if (received > opts.maxBytes) {
        throw new Error(`Response too large: >${opts.maxBytes} bytes`)
      }
      chunks.push(value)
    }

    return Buffer.concat(chunks.map((u) => Buffer.from(u)))
  } finally {
    clearTimeout(timer)
  }
}

const sanitizeForJson = (value: unknown, includeBinary: boolean): unknown => {
  if (value === null) return null
  if (value === undefined) return undefined

  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean')
    return value
  if (typeof value === 'bigint') return value.toString()

  if (value instanceof Date) return value.toISOString()

  if (Buffer.isBuffer(value)) {
    return includeBinary ? value.toString('base64') : undefined
  }

  if (ArrayBuffer.isView(value)) {
    const buf = Buffer.from(value.buffer, value.byteOffset, value.byteLength)
    return includeBinary ? buf.toString('base64') : undefined
  }

  if (value instanceof ArrayBuffer) {
    const buf = Buffer.from(value)
    return includeBinary ? buf.toString('base64') : undefined
  }

  if (Array.isArray(value)) {
    const mapped = value
      .map((v) => sanitizeForJson(v, includeBinary))
      .filter((v) => v !== undefined)
    return mapped
  }

  if (typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      const next = sanitizeForJson(v, includeBinary)
      if (next !== undefined) out[k] = next
    }
    return out
  }

  return String(value)
}

const extractExif = async (input: ToolInput) => {
  const includeBinary = input.includeBinary ?? false

  const imageBuffer = await (async (): Promise<Buffer> => {
    if (input.bytes) return Buffer.from(input.bytes)
    if (input.path) return await readFile(input.path)
    if (input.dataUrl) return Buffer.from(stripDataUrlPrefix(input.dataUrl), 'base64')
    if (input.base64) return Buffer.from(input.base64, 'base64')
    if (input.url)
      return await fetchToBuffer(input.url, {
        headers: input.headers,
        timeoutMs: input.timeoutMs ?? 15_000,
        maxBytes: input.maxBytes ?? 10_000_000,
      })
    throw new Error('No image source provided')
  })()

  const parsed = await exifr.parse(imageBuffer, {
    // broad but safe defaults
    tiff: true,
    exif: true,
    gps: true,
    xmp: true,
    iptc: true,
    icc: true,
    makerNote: false,
  })

  const tags = (parsed ?? {}) as Record<string, unknown>
  const sanitized = sanitizeForJson(tags, includeBinary) as Record<string, unknown>

  return {
    hasExif: Object.keys(sanitized).length > 0,
    tagCount: Object.keys(sanitized).length,
    tags: sanitized,
  }
}

const toolName = 'exif_extract'

const server = new McpServer(
  {
    name: 'exif-mcp',
    version: '0.1.0',
  },
  {
    capabilities: {
      tools: {},
    },
  },
)

server.registerTool(
  toolName,
  {
    title: 'EXIF Extract',
    description:
      'Extract EXIF/IPTC/XMP metadata from an image. Provide exactly one of path, base64, dataUrl, url, or bytes.',
    inputSchema: InputSchema,
    outputSchema: OutputSchema,
  },
  async (input) => {
    try {
      const result = await extractExif(input)
      return {
        content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
        structuredContent: result,
      }
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e)
      return {
        isError: true,
        content: [{ type: 'text', text: message }],
      }
    }
  },
)

const transport = new StdioServerTransport()
await server.connect(transport)
