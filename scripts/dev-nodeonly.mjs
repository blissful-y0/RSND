import { spawn } from 'node:child_process'
import net from 'node:net'

const pnpmBin = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm'
const viteArgs = process.argv.slice(2)
const backendPort = Number(process.env.PORT || 6001)

const children = []

function isPortOpen(port) {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host: '127.0.0.1', port })
    socket.once('connect', () => {
      socket.end()
      resolve(true)
    })
    socket.once('error', () => {
      resolve(false)
    })
  })
}

function start(name, args) {
  const child = spawn(pnpmBin, args, {
    cwd: process.cwd(),
    stdio: 'inherit',
    env: process.env,
  })

  child.on('exit', (code, signal) => {
    if (signal) {
      console.log(`[dev-nodeonly] ${name} exited with signal ${signal}`)
    } else if (code && code !== 0) {
      console.error(`[dev-nodeonly] ${name} exited with code ${code}`)
      shutdown(code)
    }
  })

  children.push(child)
  return child
}

function shutdown(code = 0) {
  for (const child of children) {
    if (!child.killed) {
      child.kill('SIGTERM')
    }
  }
  setTimeout(() => {
    for (const child of children) {
      if (!child.killed) {
        child.kill('SIGKILL')
      }
    }
  }, 1500).unref()
  process.exit(code)
}

process.on('SIGINT', () => shutdown(0))
process.on('SIGTERM', () => shutdown(0))

if (await isPortOpen(backendPort)) {
  console.log(`[dev-nodeonly] backend already running on port ${backendPort}, skipping node server startup`)
} else {
  start('node-server', ['runserver'])
}
start('vite', ['exec', 'vite', ...viteArgs])
