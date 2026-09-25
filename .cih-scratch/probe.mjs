// Mimics Playwright 1.63 webServer readiness: GET with no socket timeout,
// delays 100,250,500 then 1000ms, ready on 200..403. Logs each probe.
import http from 'node:http'
const port = Number(process.argv[2] || 3417)
const deadline = Date.now() + Number(process.argv[3] || 120000)
const t0 = Date.now()
const log = (m) => console.log(`[probe +${((Date.now()-t0)/1000).toFixed(2)}s] ${m}`)
function probe() {
  return new Promise((resolve) => {
    const req = http.request({ host: '127.0.0.1', port, path: '/', method: 'GET', headers: { Accept: '*/*', Host: `acme.localhost:${port}` } }, (res) => { res.resume(); resolve(res.statusCode || 0) })
    req.on('error', (e) => { resolve(0) })
    req.end()
  })
}
const delays = [100, 250, 500]
let n = 0
while (Date.now() < deadline) {
  n++
  const s = Date.now()
  const r = await Promise.race([probe(), new Promise((r) => setTimeout(() => r('PENDING'), Math.max(0, deadline - Date.now())))])
  log(`probe#${n} -> ${r} (${Date.now()-s}ms)`)
  if (typeof r === 'number' && r >= 200 && r < 404) { log('READY'); process.exit(0) }
  if (r === 'PENDING') break
  await new Promise((x) => setTimeout(x, delays.shift() || 1000))
}
log('TIMEOUT'); process.exit(1)
