// #1117 (review bounce): the scim-reconcile CronJob curls
// `http://<release>-server:9465/operator/scim/reconcile-pending`, but the server Service's `ports`
// list never named 9465 — a ClusterIP does not listen on a port its Service object never declared,
// so the sweep was `connection refused` on every scheduled run despite the container itself listening
// (containerPort 9465 was added correctly; only the Service side was forgotten, the same "added one
// side and forgot the other" shape `chart-config-checksum-1102`/`chart-workspace-host-shape-1101`
// already guard against for their own pair of files).
//
// Pinned by cross-checking the two files against each other (not by hardcoding "9465" as a raw
// number to find in the Service alone): deleting either side must turn this red.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..')
const chart = (f: string) => readFileSync(join(root, 'charts/wikistead', f), 'utf8')

describe('#1117: the scim-reconcile CronJob target port is also declared on the Service it curls', () => {
  it('the CronJob curls a port number that appears in the server Service`s own port list', () => {
    const cronjob = chart('templates/scim-reconcile-cronjob.yaml')
    const match = cronjob.match(/-server:(\d+)\/operator\/scim\/reconcile-pending/)
    expect(match, 'the CronJob curl target must name a port').not.toBeNull()
    const port = match![1]

    const server = chart('templates/server.yaml')
    const serviceBlock = server.slice(server.indexOf('kind: Service'))
    expect(serviceBlock, `Service ports must list ${port} — the port the CronJob actually curls`)
      .toMatch(new RegExp(`port:\\s*${port}\\b`))
  })

  it('the same port is also the container`s own declared listener, not just a Service-side number', () => {
    const server = chart('templates/server.yaml')
    const deploymentBlock = server.slice(0, server.indexOf('kind: Service'))
    expect(deploymentBlock).toMatch(/name:\s*scim-reconcile,\s*containerPort:\s*9465/)
  })
})
