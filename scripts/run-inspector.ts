import { spawn } from 'node:child_process'

const userArgs = process.argv.slice(2)

const hasServerArg = userArgs.some((a, i) => {
  if (a === '--server') return true
  if (a.startsWith('--server=')) return true
  // tolerate `--server foo` even if foo is missing
  return a === '--server' || (a === '--server' && typeof userArgs[i + 1] === 'string')
})

const args: string[] = ['-y', '@modelcontextprotocol/inspector', '--config', 'mcp-inspector.json']

// Inspector currently requires --server when multiple entries exist in config.
if (!hasServerArg) {
  args.push('--server', 'default-server')
}

args.push(...userArgs)

const child = spawn('npx', args, {
  stdio: 'inherit',
  env: process.env,
})

child.on('exit', (code, signal) => {
  if (signal) process.exit(1)
  process.exit(code ?? 1)
})
