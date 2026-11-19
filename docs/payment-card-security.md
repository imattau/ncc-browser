# Payment card security notes

Payment cards are stored in the password manager's encrypted vault and synchronized as a NIP-44 encrypted replaceable event. Desktop disk cache files store signed ciphertext; Android stores ciphertext in the app-private data directory. Decrypted records are held in memory while the vault is unlocked.

## Access boundaries

- Desktop content pages cannot call payment-card IPC directly. The privileged shell requests card operations from the main process, and autofill is sent only to the selected secure normal tab after confirmation.
- Android web content communicates payment form signals through an origin-aware WebMessageListener. Only HTTPS top-level messages matching the current page origin are accepted. Fill scripts check the expected origin again when they run.
- Android full-card reads require a one-use native authorization grant issued after successful system credential confirmation or verified Nostr signer confirmation. The grant expires after 60 seconds and is consumed by the read. Locking the card store clears any outstanding grant.
- Card deletion removes the card payload from the active vault and syncs a tombstone containing only the card ID and deletion timestamp. Legacy full-card deletion records are migrated when read.

## Residual risks and release checks

- The active Nostr identity key also protects the vault ciphertext. Compromise of that key may expose synchronized card data. A separately protected vault key would need a recovery and cross-device key distribution design; this remains a separate design decision.
- A relay or backup may retain an older encrypted event after the application publishes its migrated replacement. The application cannot guarantee deletion of copies held by third parties.
- Keep test and diagnostic flows on fake card details. Review logs and crash reporting whenever payment-card code changes.

These notes describe application controls; they are not a payment-industry compliance attestation.
