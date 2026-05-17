import { startWorkers } from './workers/start'

const port = Number(process.env.API_PORT ?? 3001)

const server = Bun.serve({
  port,
  fetch(req) {
    const url = new URL(req.url)

    if (url.pathname === '/health') {
      return Response.json({ ok: true, service: 'spleed-api' })
    }

    return new Response('Spleed API', { status: 200 })
  },
})

console.log(`spleed-api listening on http://localhost:${server.port}`)

// Sprint 3: start BullMQ workers in the same process as the API server.
// Sprint 12+ may split workers to a dedicated Railway service if scaling
// pressure demands it. For MVP, co-location keeps ops simple.
const running = startWorkers()
console.log(`spleed-api started ${running.count} worker(s)`)

const shutdown = async (signal: string): Promise<void> => {
  console.log(`${signal} received — stopping workers and server…`)
  await running.stop()
  server.stop()
  process.exit(0)
}

process.on('SIGTERM', () => void shutdown('SIGTERM'))
process.on('SIGINT', () => void shutdown('SIGINT'))
