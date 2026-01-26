type Args = {
  name: string
  fileBase: string
  exportName: string
  mountPath: string
  command: string
  commandArgs: string[]
  envKeys: string[]
  force: boolean
}

const usage = `
Add a new MCP server route (template generator)

Usage:
  npm run add:mcp -- --name <kebab-name> [options]

Options:
  --name <name>           Required. e.g. my-tool
  --file <fileBase>       Optional. Route filename base (default: --name)
  --export <exportName>   Optional. Export const name (default: <camelName>Route)
  --mount <path>          Optional. Mount path (default: /<fileBase>)
  --command <cmd>         Optional. Command to spawn (default: uvx)
  --arg <value>           Optional. Repeatable. Adds one argument.
  --env <KEY>             Optional. Repeatable. Adds an env passthrough key.
  --force                 Overwrite existing route file.

Examples:
  npm run add:mcp -- --name my-tool
  npm run add:mcp -- --name aws-pricing-like --command uvx --arg 'some.pkg@latest' --env AWS_REGION
  npm run add:mcp -- --name node-mcp --command npx --arg -y --arg @your/mcp-server
`.trim()

const isSafeToken = (value: string) => /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(value)

const toCamel = (kebabOrSnake: string) => {
  const parts = kebabOrSnake.split(/[-_]/g).filter(Boolean)
  if (parts.length === 0) return ''
  const [head, ...rest] = parts
  return (
    head.toLowerCase() +
    rest.map((p) => (p.length === 0 ? '' : p[0].toUpperCase() + p.slice(1).toLowerCase())).join('')
  )
}

const parseArgs = (argv: string[]): Args => {
  const args: Partial<Args> = {
    command: 'uvx',
    commandArgs: [],
    envKeys: [],
    force: false,
  }

  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]

    if (token === '--help' || token === '-h') {
      console.log(usage)
      process.exit(0)
    }

    if (token === '--force') {
      args.force = true
      continue
    }

    const next = () => {
      const v = argv[i + 1]
      if (v == null) {
        console.error(`Missing value for ${token}`)
        console.error(usage)
        process.exit(1)
      }
      i++
      return v
    }

    if (token === '--name') args.name = next()
    else if (token === '--file') args.fileBase = next()
    else if (token === '--export') args.exportName = next()
    else if (token === '--mount') args.mountPath = next()
    else if (token === '--command') args.command = next()
    else if (token === '--arg') args.commandArgs = [...(args.commandArgs ?? []), next()]
    else if (token === '--env') args.envKeys = [...(args.envKeys ?? []), next()]
    else {
      console.error(`Unknown arg: ${token}`)
      console.error(usage)
      process.exit(1)
    }
  }

  if (!args.name) {
    console.error('--name is required')
    console.error(usage)
    process.exit(1)
  }

  if (!isSafeToken(args.name)) {
    console.error(`Invalid --name: ${args.name}`)
    console.error('Allowed: alnum plus . _ -')
    process.exit(1)
  }

  const fileBase = args.fileBase ?? args.name
  if (!isSafeToken(fileBase)) {
    console.error(`Invalid --file: ${fileBase}`)
    process.exit(1)
  }

  const defaultExport = `${toCamel(args.name)}Route`
  const exportName = args.exportName ?? defaultExport
  if (!/^[a-zA-Z_$][a-zA-Z0-9_$]*$/.test(exportName)) {
    console.error(`Invalid --export: ${exportName}`)
    process.exit(1)
  }

  const mountPath = (() => {
    const p = args.mountPath ?? `/${fileBase}`
    return p.startsWith('/') ? p : `/${p}`
  })()

  return {
    name: args.name,
    fileBase,
    exportName,
    mountPath,
    command: args.command ?? 'uvx',
    commandArgs: args.commandArgs ?? [],
    envKeys: args.envKeys ?? [],
    force: args.force ?? false,
  }
}

const main = async () => {
  const fs = await import('node:fs/promises')
  const path = await import('node:path')

  const root = process.cwd()
  const cfg = parseArgs(process.argv.slice(2))

  const indexPath = path.join(root, 'src', 'index.ts')
  const routesDir = path.join(root, 'src', 'routes')
  const routeTsPath = path.join(routesDir, `${cfg.fileBase}.ts`)

  try {
    await fs.access(indexPath)
  } catch {
    console.error(`Not found: ${indexPath}`)
    process.exit(1)
  }

  await fs.mkdir(routesDir, { recursive: true })

  // 1) Create route template
  const routeExists = await fs
    .access(routeTsPath)
    .then(() => true)
    .catch(() => false)

  if (routeExists && !cfg.force) {
    console.error(`Route already exists: ${routeTsPath}`)
    console.error('Use --force to overwrite.')
    process.exit(1)
  }

  const argsLiteral =
    cfg.commandArgs.length > 0
      ? JSON.stringify(cfg.commandArgs, null, 2)
          .split('\n')
          .map((l) => (l.trim().length === 0 ? l : `  ${l}`))
          .join('\n')
      : "['<your-mcp-package>@latest']"

  const envLiteral =
    cfg.envKeys.length > 0
      ? `\n  env: {\n${cfg.envKeys
          .map((k) => `    ${k}: process.env.${k} ?? '',`)
          .join('\n')}\n  },`
      : ''

  const routeContents = `import { createMcpProxy } from '../lib/mcp-proxy.js'

export const ${cfg.exportName} = createMcpProxy({
  command: '${cfg.command}',
  args: ${argsLiteral},${envLiteral}
})
`

  await fs.writeFile(routeTsPath, routeContents, 'utf8')

  // 2) Update src/index.ts (import + mount)
  const indexSrc = await fs.readFile(indexPath, 'utf8')

  const importLine = `import { ${cfg.exportName} } from './routes/${cfg.fileBase}.js'`
  const mountLine = `app.route('${cfg.mountPath}', ${cfg.exportName})`

  let nextIndexSrc = indexSrc

  if (!nextIndexSrc.includes(importLine)) {
    const routeImportRe = /^import \{ [^}]+ \} from '\.\/routes\/.+\.js'\s*$/gm
    const matches = [...nextIndexSrc.matchAll(routeImportRe)]
    if (matches.length > 0) {
      const last = matches[matches.length - 1]
      const insertAt = (last.index ?? 0) + last[0].length
      nextIndexSrc = `${nextIndexSrc.slice(0, insertAt)}\n${importLine}${nextIndexSrc.slice(insertAt)}`
    } else {
      const lastImportRe = /^import .+$/gm
      const allImports = [...nextIndexSrc.matchAll(lastImportRe)]
      if (allImports.length > 0) {
        const last = allImports[allImports.length - 1]
        const insertAt = (last.index ?? 0) + last[0].length
        nextIndexSrc = `${nextIndexSrc.slice(0, insertAt)}\n${importLine}${nextIndexSrc.slice(insertAt)}`
      } else {
        nextIndexSrc = `${importLine}\n${nextIndexSrc}`
      }
    }
  }

  if (!nextIndexSrc.includes(mountLine)) {
    const serveIdx = nextIndexSrc.indexOf('serve({')
    if (serveIdx !== -1) {
      nextIndexSrc = `${nextIndexSrc.slice(0, serveIdx)}${mountLine}\n\n${nextIndexSrc.slice(serveIdx)}`
    } else {
      nextIndexSrc = `${nextIndexSrc}\n\n${mountLine}\n`
    }
  }

  if (nextIndexSrc !== indexSrc) {
    await fs.writeFile(indexPath, nextIndexSrc, 'utf8')
  }

  console.log('✅ MCP route generated')
  console.log(`- Route: src/routes/${cfg.fileBase}.ts (export: ${cfg.exportName})`)
  console.log(`- Mounted: ${cfg.mountPath}`)
  console.log('Next: review the command/args/env in the new route file.')
}

await main()
