import test from "node:test"
import assert from "node:assert/strict"
import {
    PRESET_FIELD_DEFS,
    PRESET_FIELDS,
    PRESET_CONSTRUCTOR_FIELDS,
    isPresetField,
    getPresetFieldMeta,
    hasPresetTypeMismatch,
} from "../../core/transcode/preset_schema.js"

test("isPresetField 只认 Schema 白名单字段", () => {
    assert.equal(isPresetField("format"), true)
    assert.equal(isPresetField("videoQuality"), true)
    assert.equal(isPresetField("_override"), true)
    // 未声明的字段必须被拒（loader 依赖它丢弃未知键）
    assert.equal(isPresetField("bogus"), false)
    assert.equal(isPresetField(""), false)
})

test("getPresetFieldMeta 返回声明的类型与 construct 标记", () => {
    assert.equal(getPresetFieldMeta("videoQuality")?.type, "number")
    assert.equal(getPresetFieldMeta("format")?.type, "string")
    assert.equal(getPresetFieldMeta("_override")?.type, "boolean")
    assert.equal(getPresetFieldMeta("extends")?.construct, false)
    assert.equal(getPresetFieldMeta("format")?.construct, true)
    assert.equal(getPresetFieldMeta("not-a-field"), undefined)
})

test("hasPresetTypeMismatch 按声明类型判定，未知字段不报错", () => {
    // number 字段
    assert.equal(hasPresetTypeMismatch("videoQuality", 20), false)
    assert.equal(hasPresetTypeMismatch("videoQuality", "20"), true)
    assert.equal(hasPresetTypeMismatch("videoQuality", NaN), true)
    // string 字段
    assert.equal(hasPresetTypeMismatch("format", ".mp4"), false)
    assert.equal(hasPresetTypeMismatch("format", 123), true)
    // boolean 字段
    assert.equal(hasPresetTypeMismatch("_override", true), false)
    assert.equal(hasPresetTypeMismatch("_override", "true"), true)
    // 未知字段：无声明可依据，返回 false（不误伤）
    assert.equal(hasPresetTypeMismatch("bogus", 123), false)
})

test("构造器字段集是白名单子集，且元信息字段不进构造器", () => {
    for (const key of PRESET_CONSTRUCTOR_FIELDS) {
        assert.equal(PRESET_FIELDS.has(key), true, `${key} 应在 PRESET_FIELDS 内`)
    }
    assert.equal(PRESET_CONSTRUCTOR_FIELDS.has("format"), true)
    assert.equal(PRESET_CONSTRUCTOR_FIELDS.has("videoQuality"), true)
    // 仅 loader/合并逻辑消费的元信息字段
    for (const key of ["extends", "name", "description", "intro", "_override"]) {
        assert.equal(PRESET_CONSTRUCTOR_FIELDS.has(key), false, `${key} 不应进构造器`)
    }
})

test("字段定义结构完整（type/construct/comment 齐备）", () => {
    const allowedTypes = new Set(["string", "number", "boolean"])
    for (const [key, meta] of Object.entries(PRESET_FIELD_DEFS)) {
        assert.equal(allowedTypes.has(meta.type), true, `${key} 的 type 非法: ${meta.type}`)
        assert.equal(typeof meta.construct, "boolean", `${key} 缺 construct`)
        assert.equal(typeof meta.comment, "string", `${key} 缺 comment`)
    }
})