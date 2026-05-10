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
