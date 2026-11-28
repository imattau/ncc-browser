import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

// White Noise's MDK/0.8 KeyPackage events contain the base64-encoded TLS
// KeyPackage directly. marmot-ts 0.9.0 currently expects the same bytes to be
// wrapped in an MLSMessage. Accept both forms at this decoder boundary; all of
// marmot-ts's normal event, lifetime, credential, and proposal checks still run.
const target = resolve(import.meta.dirname, 'node_modules/@internet-privacy/marmot-ts/dist/core/key-package-event-decode.js')
let source = readFileSync(target, 'utf8')
const oldImport = 'import { ciphersuites, decode, defaultCredentialTypes, mlsMessageDecoder, wireformats, } from "../vendor/ts-mls/index.js";'
const newImport = 'import { ciphersuites, decode, defaultCredentialTypes, keyPackageDecoder, mlsMessageDecoder, wireformats, } from "../vendor/ts-mls/index.js";'
if (source.includes(oldImport)) source = source.replace(oldImport, newImport)
const oldDecode = [
  '    const message = decode(mlsMessageDecoder, content);',
  '    if (!message)',
  '        throw new Error("Failed to decode key package event content");',
  '    if (message.wireformat !== wireformats.mls_key_package)',
  '        throw new Error(`Expected MLSMessage with mls_key_package wireformat, got wireformat ${message.wireformat}`);',
  '    return message.keyPackage;'
].join('\n')
const newDecode = [
  '    const message = decode(mlsMessageDecoder, content);',
  '    if (message) {',
  '        if (message.wireformat !== wireformats.mls_key_package)',
  '            throw new Error(`Expected MLSMessage with mls_key_package wireformat, got wireformat ${message.wireformat}`);',
  '        return message.keyPackage;',
  '    }',
  '    // MDK/0.8 (used by White Noise Android) publishes the TLS-serialized',
  '    // KeyPackage directly instead of an MLSMessage-wrapped KeyPackage.',
  '    const keyPackage = decode(keyPackageDecoder, content);',
  '    if (!keyPackage)',
  '        throw new Error("Failed to decode key package event content");',
  '    return keyPackage;'
].join('\n')
if (source.includes(oldDecode)) source = source.replace(oldDecode, newDecode)
if (!source.includes(newImport) || !source.includes('const keyPackage = decode(keyPackageDecoder, content);')) {
  throw new Error('Unsupported marmot-ts version: expected key-package decoder source was not found')
}
writeFileSync(target, source)
