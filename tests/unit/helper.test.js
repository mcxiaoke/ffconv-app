import test from "node:test"
import assert from "node:assert/strict"
import path from "node:path"
import {
    parseBitrate,
    pathRewrite,
    pathExt,
    isReservedWindowsName,
    filenameSafe,
} from "../../core/lib/helper.js"

test("parseBitrate 归一单位到 bps", () => {
    assert.equal(parseBitrate("2000000"), 2000000)
    assert.equal(parseBitrate("233k"), 233000)
    assert.equal(parseBitrate("3M"), 3000000)
    assert.equal(parseBitrate("1.5m"), 1500000)
    assert.equal(parseBitrate("1.5g"), 1500000000)
    assert.equal(parseBitrate("  2M  "), 2000000)
    assert.equal(parseBitrate(233000), 233000)
    assert.equal(parseBitrate(0), 0)
})

test("parseBitrate 对非法输入抛出而非静默返回 0", () => {
    assert.throws(() => parseBitrate(""))
    assert.throws(() => parseBitrate("abc"))
    assert.throws(() => parseBitrate("2x"))
    assert.throws(() => parseBitrate(Number.NaN))
    assert.throws(() => parseBitrate(-1))
})

test("pathRewrite 的 keepRoot 两种语义", () => {
    // 用 path.join 构造，保证 Windows/Linux 断言一致
    const root = path.join("X:", "media", "in")
    const input = path.join(root, "sub", "a.mkv")
    const output = path.join("X:", "out")

    // keepRoot=true：相对 root 的父目录，保留 root 目录名
    assert.equal(
        pathRewrite(root, input, output, true),
        path.join(output, "in", "sub", "a.mkv"),
    )
    // keepRoot=false：相对 root，去掉 root 目录名
    assert.equal(
        pathRewrite(root, input, output, false),
        path.join(output, "sub", "a.mkv"),
    )
    // 默认 keepRoot=true
    assert.equal(pathRewrite(root, input, output), pathRewrite(root, input, output, true))
})

test("pathExt 默认小写", () => {
    assert.equal(pathExt("A.MKV"), ".mkv")
    assert.equal(pathExt("A.MKV", false), ".MKV")
    assert.equal(pathExt("noext"), "")
})

test("isReservedWindowsName 拦截保留设备名", () => {
    for (const name of ["CON", "con", "PRN.txt", "AUX", "NUL", "COM1", "LPT9.mp4"]) {
        assert.equal(isReservedWindowsName(name), true, `${name} 应被判定为保留名`)
    }
    for (const name of ["console.mp4", "com10.txt", "my.nul", ""]) {
        assert.equal(isReservedWindowsName(name), false, `${name} 不应被判定为保留名`)
    }
    assert.equal(isReservedWindowsName(12), false)
})

test("filenameSafe 规范化并清理非法字符", () => {
    assert.equal(filenameSafe("a<b>c.txt"), "abc.txt")
    assert.equal(filenameSafe("  a  b.mp4"), "ab.mp4")
    assert.equal(filenameSafe('q"uote|star*.mkv'), "quotestar.mkv")
    // 保留名加下划线前缀规避，而不是丢弃整个名字
    assert.equal(filenameSafe("CON"), "_CON")
    assert.equal(filenameSafe("CON.txt"), "_CON.txt")
    // 正常名字不被改动
    assert.equal(filenameSafe("正常-文件名.mkv"), "正常-文件名.mkv")
    // 非字符串原样返回
    assert.equal(filenameSafe(undefined), undefined)
})