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

// White Noise's MDK/0.8 deployment expects kind-30443 content to be the raw
// TLS KeyPackage, while the current Marmot transport frames it as MLSMessage.
// Keep the modern encoder in marmot-ts, but let the companion opt into the
// legacy wire form before the event is signed. The browser toggle is controlled
// by panel.js and defaults to the tested White Noise Android compatibility mode.
const publisher = resolve(import.meta.dirname, 'node_modules/@internet-privacy/marmot-ts/dist/client/key-package-publisher.js')
let publisherSource = readFileSync(publisher, 'utf8')
const oldSign = '        const signed = await this.#signer.signEvent(eventTemplate);'
const newSign = [
  '        if (globalThis.__NCC_WHITE_NOISE_KEY_PACKAGE_ENCODING__ === "mdk08-raw" && eventTemplate.kind === 30443) {',
  '            const bytes = Uint8Array.from(atob(eventTemplate.content), (character) => character.charCodeAt(0));',
  '            if (bytes.length < 5 || bytes[0] !== 0 || bytes[1] !== 1 || bytes[2] !== 0 || bytes[3] !== 5) {',
  '                throw new Error("Cannot convert framed KeyPackage to MDK/0.8 legacy content");',
  '            }',
  '            let binary = "";',
  '            for (const byte of bytes.subarray(4)) binary += String.fromCharCode(byte);',
  '            eventTemplate.content = btoa(binary);',
  '        }',
  oldSign,
].join('\n')
const legacyPublisherMarker = 'globalThis.__NCC_WHITE_NOISE_KEY_PACKAGE_ENCODING__ === "mdk08-raw"'
if (!publisherSource.includes(legacyPublisherMarker)) {
  if (!publisherSource.includes(oldSign)) {
    throw new Error('Unsupported marmot-ts version: expected KeyPackage publisher sign boundary was not found')
  }
  publisherSource = publisherSource.replace(oldSign, newSign)
}
if (!publisherSource.includes('globalThis.__NCC_WHITE_NOISE_KEY_PACKAGE_ENCODING__ === "mdk08-raw"')) {
  throw new Error('Unsupported marmot-ts version: expected KeyPackage publisher sign boundary was not found')
}
writeFileSync(publisher, publisherSource)

// White Noise Android activates account-devices (0x800d), a required group
// component with no data location. Advertise it on KeyPackages and teach the
// current Marmot join/integrity validators that this registered component is
// intentionally data-less. Do not make it a default for groups we create.
const componentIds = resolve(import.meta.dirname, 'node_modules/@internet-privacy/marmot-ts/dist/core/components/ids.js')
let componentSource = readFileSync(componentIds, 'utf8')
function editExportArray(source, name, edit) {
  const start = source.indexOf(`export const ${name} = [`)
  if (start < 0) throw new Error(`Unsupported marmot-ts version: ${name} was not found`)
  const end = source.indexOf('\n];', start)
  if (end < 0) throw new Error(`Unsupported marmot-ts version: ${name} did not terminate`)
  const block = source.slice(start, end + 3)
  return source.slice(0, start) + edit(block) + source.slice(end + 3)
}
componentSource = editExportArray(componentSource, 'DEFAULT_GROUP_COMPONENT_IDS', block =>
  block.replace(/\n\s*0x800d, \/\/[^\n]*/, ''))
componentSource = editExportArray(componentSource, 'SUPPORTED_APP_COMPONENT_IDS', block => {
  block = block.replace(/\n\s*0x800d, \/\/[^\n]*/, '')
  return block.replace('\n];', '\n    0x800d, // marmot.group.account-devices.v1 (data-less required component)\n];')
})
if (!componentSource.includes('0x800d, // marmot.group.account-devices.v1 (data-less required component)')) {
  throw new Error('Unsupported marmot-ts version: supported app-component list was not found')
}
writeFileSync(componentIds, componentSource)

const integrity = resolve(import.meta.dirname, 'node_modules/@internet-privacy/marmot-ts/dist/core/components/integrity.js')
let integritySource = readFileSync(integrity, 'utf8')
const oldKnown = '    0x8008, 0x800b, 0x800c,\n]);'
const newKnown = '    0x8008, 0x800b, 0x800c, 0x800d,\n]);'
if (integritySource.includes(oldKnown)) integritySource = integritySource.replace(oldKnown, newKnown)
const oldStateGuard = '        if (!hasState(id))\n            return fail(`required component 0x${id.toString(16)} has no state`);'
const newStateGuard = '        if (id !== 0x800d && !hasState(id))\n            return fail(`required component 0x${id.toString(16)} has no state`);'
if (integritySource.includes(oldStateGuard)) integritySource = integritySource.replace(oldStateGuard, newStateGuard)
const noDataGuard = '    const hasState = (id) => dictionary.some((entry) => entry.componentId === id);\n    if (requiredComponents.includes(0x800d) && hasState(0x800d))\n        return fail("account-devices component 0x800d must not carry data");'
if (!integritySource.includes('account-devices component 0x800d must not carry data')) {
  integritySource = integritySource.replace('    const hasState = (id) => dictionary.some((entry) => entry.componentId === id);', noDataGuard)
}
if (!integritySource.includes('0x8008, 0x800b, 0x800c, 0x800d,') || !integritySource.includes('id !== 0x800d && !hasState(id)') || !integritySource.includes('account-devices component 0x800d must not carry data')) {
  throw new Error('Unsupported marmot-ts version: resulting-state component validation was not found')
}
writeFileSync(integrity, integritySource)

const welcomeJoin = resolve(import.meta.dirname, 'node_modules/@internet-privacy/marmot-ts/dist/core/welcome-join.js')
let welcomeSource = readFileSync(welcomeJoin, 'utf8')
const oldWelcomeGuard = '        if (id !== ACCOUNT_IDENTITY_PROOF_COMPONENT_ID &&\n            !dictionary.some((entry) => entry.componentId === id))'
const newWelcomeGuard = '        if (id !== ACCOUNT_IDENTITY_PROOF_COMPONENT_ID && id !== 0x800d &&\n            !dictionary.some((entry) => entry.componentId === id))'
if (welcomeSource.includes(oldWelcomeGuard)) welcomeSource = welcomeSource.replace(oldWelcomeGuard, newWelcomeGuard)
if (!welcomeSource.includes('id !== ACCOUNT_IDENTITY_PROOF_COMPONENT_ID && id !== 0x800d &&')) {
  throw new Error('Unsupported marmot-ts version: Welcome required-component validation was not found')
}
const welcomeDataGuard = '    if (required.includes(0x800d) && dictionary.some((entry) => entry.componentId === 0x800d))\n        throw new Error("Welcome account-devices component 0x800d must not carry data");'
if (!welcomeSource.includes('Welcome account-devices component 0x800d must not carry data')) {
  welcomeSource = welcomeSource.replace('    for (const id of required) {', `${welcomeDataGuard}\n    for (const id of required) {`)
}
writeFileSync(welcomeJoin, welcomeSource)

// Blossom servers can be unavailable or reject an opaque encrypted image.
// Upload the same ciphertext to every approved endpoint for redundancy, but
// commit MLS metadata if at least one upload passes Marmot's descriptor checks.
// Downloads try each authorized endpoint in order and stop at the first image
// whose response decrypts and validates.
const groupsManager = resolve(import.meta.dirname, 'node_modules/@internet-privacy/marmot-ts/dist/client/groups-manager.js')
let groupsManagerSource = readFileSync(groupsManager, 'utf8')
const oldImageUpload = [
  '                    const endpoint = endpoints[0];',
  '                    const hash = bytesToHex(encrypted.metadata.imageHash);',
  '                    const response = await requestGroupImage(profile, {',
  '                        url: `${endpoint}/upload`,',
  '                        method: "PUT",',
  '                        headers: {',
  '                            "Content-Type": "application/octet-stream",',
  '                            "X-SHA-256": hash,',
  '                            Authorization: createGroupImageUploadAuthorization(endpoint, encrypted.metadata),',
  '                        },',
  '                        body: encrypted.ciphertext,',
  '                        maxBytes: groupImageLimit(profile.maxDescriptorBytes, 16 * 1024),',
  '                    }, { signal });',
  '                    validateGroupImageUploadResponse(response, endpoint, hash, encrypted.ciphertext.length);'
].join('\n')
const previousRetryImageUpload = [
  '                    const hash = bytesToHex(encrypted.metadata.imageHash);',
  '                    let lastUploadError;',
  '                    for (const endpoint of endpoints) {',
  '                        try {',
  '                            const response = await requestGroupImage(profile, {',
  '                                url: `${endpoint}/upload`,',
  '                                method: "PUT",',
  '                                headers: {',
  '                                    "Content-Type": "application/octet-stream",',
  '                                    "X-SHA-256": hash,',
  '                                    Authorization: createGroupImageUploadAuthorization(endpoint, encrypted.metadata),',
  '                                },',
  '                                body: encrypted.ciphertext,',
  '                                maxBytes: groupImageLimit(profile.maxDescriptorBytes, 16 * 1024),',
  '                            }, { signal });',
  '                            validateGroupImageUploadResponse(response, endpoint, hash, encrypted.ciphertext.length);',
  '                            lastUploadError = undefined;',
  '                            break;',
  '                        } catch (error) {',
  '                            if (signal.aborted)',
  '                                throw error;',
  '                            lastUploadError = error;',
  '                        }',
  '                    }',
  '                    if (lastUploadError)',
  '                        throw lastUploadError;'
].join('\n')
const newImageUpload = [
  '                    const hash = bytesToHex(encrypted.metadata.imageHash);',
  '                    const uploadResults = await Promise.allSettled(endpoints.map(async (endpoint) => {',
  '                        const response = await requestGroupImage(profile, {',
  '                                url: `${endpoint}/upload`,',
  '                                method: "PUT",',
  '                                headers: {',
  '                                    "Content-Type": "application/octet-stream",',
  '                                    "X-SHA-256": hash,',
  '                                    Authorization: createGroupImageUploadAuthorization(endpoint, encrypted.metadata),',
  '                                },',
  '                                body: encrypted.ciphertext,',
  '                                maxBytes: groupImageLimit(profile.maxDescriptorBytes, 16 * 1024),',
  '                        }, { signal });',
  '                        validateGroupImageUploadResponse(response, endpoint, hash, encrypted.ciphertext.length);',
  '                        return endpoint;',
  '                    }));',
  '                    if (signal.aborted)',
  '                        throw new GroupImageRequestError("cancelled");',
  '                    const successfulUploads = uploadResults.filter((result) => result.status === "fulfilled");',
  '                    if (successfulUploads.length === 0) {',
  '                        const lastFailure = uploadResults.at(-1);',
  '                        throw lastFailure?.status === "rejected" ? lastFailure.reason : new GroupImageRequestError("transport");',
  '                    }'
].join('\n')
const imageUploadMarker = 'const successfulUploads = uploadResults.filter((result) => result.status === "fulfilled");'
if (groupsManagerSource.includes(oldImageUpload)) groupsManagerSource = groupsManagerSource.replace(oldImageUpload, newImageUpload)
else if (groupsManagerSource.includes(previousRetryImageUpload)) groupsManagerSource = groupsManagerSource.replace(previousRetryImageUpload, newImageUpload)
if (!groupsManagerSource.includes(imageUploadMarker)) {
  throw new Error('Unsupported marmot-ts version: group image redundancy boundary was not found')
}
writeFileSync(groupsManager, groupsManagerSource)

const groupImageService = resolve(import.meta.dirname, 'node_modules/@internet-privacy/marmot-ts/dist/client/group/group-image-service.js')
let groupImageServiceSource = readFileSync(groupImageService, 'utf8')
const oldImageFetch = [
  '    async fetch(profile, source, effective, signal) {',
  '        try {',
  '            const endpoint = effective.endpoints.find((_, index) => effective.authorization[index]);',
  '            if (!endpoint)',
  '                throw new GroupImageRequestError("contact-denied");',
  '            const response = await requestGroupImage(profile, {',
  '                url: `${endpoint}/${bytesToHex(source.metadata.imageHash)}`,',
  '                method: "GET",',
  '                headers: {},',
  '                maxBytes: effective.maxDownloadBytes,',
  '            }, { signal });',
  '            this.current(source);',
  '            if (response.status === 404)',
  '                throw new GroupImageReadError("missing-blob");',
  '            if (response.status !== 200)',
  '                throw new GroupImageRequestError("invalid-response");',
  '            const bytes = decryptGroupImage(response.body, source.metadata);',
  '            if (bytes.length > effective.maxUploadBytes) {',
  '                bytes.fill(0);',
  '                throw new GroupImageRequestError("byte-limit");',
  '            }',
  '            this.current(source);',
  '            this.plaintext.add(bytes);',
  '            return {',
  '                kind: "available",',
  '                bytes,',
  '                mediaType: source.metadata.mediaType,',
  '                snapshotIdentity: source.snapshotIdentity,',
  '                ciphertextBytes: response.body.length,',
  '            };',
  '        }',
  '        catch (error) {',
  '            return groupImageUnavailable(error);',
  '        }',
  '    }'
].join('\n')
const newImageFetch = [
  '    async fetch(profile, source, effective, signal) {',
  '        try {',
  '            const endpoints = effective.endpoints.filter((_, index) => effective.authorization[index]);',
  '            if (!endpoints.length)',
  '                throw new GroupImageRequestError("contact-denied");',
  '            let lastError;',
  '            for (const endpoint of endpoints) {',
  '                try {',
  '                    const response = await requestGroupImage(profile, {',
  '                        url: `${endpoint}/${bytesToHex(source.metadata.imageHash)}`,',
  '                        method: "GET",',
  '                        headers: {},',
  '                        maxBytes: effective.maxDownloadBytes,',
  '                    }, { signal });',
  '                    this.current(source);',
  '                    if (response.status === 404)',
  '                        throw new GroupImageReadError("missing-blob");',
  '                    if (response.status !== 200)',
  '                        throw new GroupImageRequestError("invalid-response");',
  '                    const bytes = decryptGroupImage(response.body, source.metadata);',
  '                    if (bytes.length > effective.maxUploadBytes) {',
  '                        bytes.fill(0);',
  '                        throw new GroupImageRequestError("byte-limit");',
  '                    }',
  '                    this.current(source);',
  '                    this.plaintext.add(bytes);',
  '                    return {',
  '                        kind: "available",',
  '                        bytes,',
  '                        mediaType: source.metadata.mediaType,',
  '                        snapshotIdentity: source.snapshotIdentity,',
  '                        ciphertextBytes: response.body.length,',
  '                    };',
  '                } catch (error) {',
  '                    if (signal.aborted || error instanceof GroupImageReadError && (error.reason === "closed" || error.reason === "stale"))',
  '                        throw error;',
  '                    lastError = error;',
  '                }',
  '            }',
  '            throw lastError ?? new GroupImageRequestError("contact-denied");',
  '        } catch (error) {',
  '            return groupImageUnavailable(error);',
  '        }',
  '    }'
].join('\n')
const imageFetchMarker = 'const endpoints = effective.endpoints.filter((_, index) => effective.authorization[index]);'
if (groupImageServiceSource.includes(oldImageFetch)) groupImageServiceSource = groupImageServiceSource.replace(oldImageFetch, newImageFetch)
if (!groupImageServiceSource.includes(imageFetchMarker)) {
  throw new Error('Unsupported marmot-ts version: group image download fallback boundary was not found')
}
writeFileSync(groupImageService, groupImageServiceSource)

// Regular chat attachments should have the same redundancy as group photos:
// upload the one encrypted blob to every configured Blossom endpoint and put
// every successful locator on the MLS rumor. The stock media-transfer helper
// stops after the first successful endpoint, which leaves the attachment
// unavailable when that one host later goes down. Its download helper already
// tries locators in order and continues after fetch/decrypt failures.
const mediaTransfer = resolve(import.meta.dirname, 'node_modules/@internet-privacy/marmot-ts/dist/client/group/media-transfer.js')
let mediaTransferSource = readFileSync(mediaTransfer, 'utf8')
const oldMediaUpload = [
  '        let lastError;',
  '        for (const endpoint of policy.defaultBlobEndpoints) {',
  '            if (endpoint.locatorKind !== "blossom-v1" ||',
  '                !policy.allowedLocatorKinds.includes(endpoint.locatorKind))',
  '                continue;',
  '            group.session.assertOutboundOpen();',
  '            if (group.session.parentToken !== expectedParent)',
  '                throw new StaleMediaPreparationError();',
  '            try {',
  '                const value = await cancellable(signal, () => options.transport.upload({',
  '                    baseUrl: endpoint.baseUrl,',
  '                    data: prepared.encrypted,',
  '                    ciphertextSha256: prepared.attachment.ciphertextSha256,',
  '                    signal,',
  '                    maxBytes,',
  '                }));',
  '                const attachment = {',
  '                    ...prepared.attachment,',
  '                    locators: [{ kind: "blossom-v1", value }],',
  '                };',
  '                encodeMediaImetaTag(attachment);',
  '                prepared.attachment = attachment;',
  '                lastError = undefined;',
  '                break;',
  '            }',
  '            catch (error) {',
  '                lastError = error;',
  '                signal.throwIfAborted();',
  '            }',
  '        }',
  '        if (!prepared.attachment.locators.length)',
  '            throw lastError ?? new Error("No usable media upload endpoint");'
].join('\n')
const redundantMediaUpload = [
  '        const uploadEndpoints = policy.defaultBlobEndpoints.filter((endpoint) =>',
  '            endpoint.locatorKind === "blossom-v1" &&',
  '            policy.allowedLocatorKinds.includes(endpoint.locatorKind));',
  '        const uploadResults = await Promise.allSettled(uploadEndpoints.map(async (endpoint) => {',
  '            group.session.assertOutboundOpen();',
  '            if (group.session.parentToken !== expectedParent)',
  '                throw new StaleMediaPreparationError();',
  '            const value = await cancellable(signal, () => options.transport.upload({',
  '                baseUrl: endpoint.baseUrl,',
  '                data: prepared.encrypted,',
  '                ciphertextSha256: prepared.attachment.ciphertextSha256,',
  '                signal,',
  '                maxBytes,',
  '            }));',
  '            const locator = { kind: "blossom-v1", value };',
  '            encodeMediaImetaTag({ ...prepared.attachment, locators: [locator] });',
  '            return locator;',
  '        }));',
  '        signal.throwIfAborted();',
  '        group.session.assertOutboundOpen();',
  '        if (group.session.parentToken !== expectedParent)',
  '            throw new StaleMediaPreparationError();',
  '        const locators = uploadResults.flatMap((result) => result.status === "fulfilled" ? [result.value] : []);',
  '        if (locators.length === 0) {',
  '            const lastFailure = uploadResults.at(-1);',
  '            throw lastFailure?.status === "rejected" ? lastFailure.reason : new Error("No usable media upload endpoint");',
  '        }',
  '        prepared.attachment = { ...prepared.attachment, locators };',
  '        encodeMediaImetaTag(prepared.attachment);'
].join('\n')
if (mediaTransferSource.includes(oldMediaUpload)) mediaTransferSource = mediaTransferSource.replace(oldMediaUpload, redundantMediaUpload)
if (!mediaTransferSource.includes('const uploadResults = await Promise.allSettled(uploadEndpoints.map(async (endpoint) => {') ||
    !mediaTransferSource.includes('const locators = uploadResults.flatMap((result) => result.status === "fulfilled" ? [result.value] : []);')) {
  throw new Error('Unsupported marmot-ts version: regular media upload redundancy boundary was not found')
}
writeFileSync(mediaTransfer, mediaTransferSource)
