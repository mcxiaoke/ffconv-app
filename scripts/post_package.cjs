const fs = require("node:fs")
const path = require("node:path")

const releaseDir = path.resolve(__dirname, "../release")
const pkg = require("../package.json")
const version = pkg.version || "0.1.0"
const winZip = path.join(releaseDir, `FFConv GUI-${version}-win.zip`)
const portableZip = path.join(releaseDir, `FFConv GUI-${version}-portable.zip`)

if (fs.existsSync(winZip)) {
    fs.copyFileSync(winZip, portableZip)
    console.log(`[post-package] Generated portable zip: ${path.basename(portableZip)}`)
}
