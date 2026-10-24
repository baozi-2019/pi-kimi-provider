/**
 * Guards the publishable package manifest: pi host packages stay optional
 * peers (installed by the host, never by us) and the published file set keeps
 * every file pi needs at runtime.
 */

import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import { describe, it } from "node:test"

interface PackageManifest {
  files?: string[]
  dependencies?: Record<string, string>
  devDependencies?: Record<string, string>
  peerDependencies?: Record<string, string>
  peerDependenciesMeta?: Record<string, { optional?: boolean }>
  pi?: { extensions?: string[] }
}

const HOST_PACKAGES = ["@earendil-works/pi-coding-agent", "@earendil-works/pi-tui"] as const

async function readPackageManifest(): Promise<PackageManifest> {
  const contents = await readFile(new URL("../package.json", import.meta.url), "utf-8")
  return JSON.parse(contents) as PackageManifest
}

describe("package manifest", () => {
  it("uses pi's bundled packages as optional peers instead of installing copies", async () => {
    const manifest = await readPackageManifest()
    for (const packageName of HOST_PACKAGES) {
      assert.equal(manifest.dependencies?.[packageName], undefined)
      assert.equal(manifest.devDependencies?.[packageName], undefined)
      assert.equal(manifest.peerDependencies?.[packageName], "*")
      assert.equal(manifest.peerDependenciesMeta?.[packageName]?.optional, true)
    }
  })

  it("exposes the extension entrypoint to pi and publishes the runtime files", async () => {
    const manifest = await readPackageManifest()
    assert.deepEqual(manifest.pi?.extensions, ["./index.ts"])
    for (const file of ["index.ts", "src/", "README.md", "LICENSE"]) {
      assert.ok(manifest.files?.includes(file), `files must include ${file}`)
    }
  })

  it("has no runtime dependencies (host provides everything)", async () => {
    const manifest = await readPackageManifest()
    assert.deepEqual(manifest.dependencies ?? {}, {})
  })
})
