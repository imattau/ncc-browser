/**
 * Path shim. The settings page and its sections live in `./settings/`; this keeps the
 * existing `./components/SettingsPage` imports working while the chrome is migrated.
 */
export { SettingsPage } from './settings/SettingsPage'
export type { SettingsSection } from './settings/SettingsPage'
