# Seed hypotheses

**Unverified leads.** Some may be already-fixed or plain wrong. Verify each in the code before
reporting it, treat it as a starting point rather than a boundary, and expect the best finding to be
somewhere else. Remove a seed here once the threat model records it as closed or accepted.

1. AAD has no version or sequence component → a malicious server rolls a cell back to an older
   valid ciphertext of the same cell. `C3` lists same-cell rollback as covered while noting the AAD
   carries no version: test which one is true. (`C3`)
2. Anything that gets a v2-era value decoded through the AAD-free `"v1"` slot, or a v1-format value
   accepted on a fresh row, sidesteps THU-426. The slot itself is accepted; only *new* exposure
   through it is a finding. (`C4`)
3. `canary_secret_hash` gates `/upgrade`: is the possession proof replayable, and is the hash a
   cheap offline target? (A2 authoring the hash is the accepted `C8` concession.) (`C8`)
4. `GET /encryption/keys` serves keyring rows to every non-revoked device of the account, pending
   ones included, justified as "AES-KW-useless without the AK". Re-derive whether that still holds
   for denied devices and for the `key_id`-bound wrap. (`C14`)
5. Unknown-`key_id` handling in the sync worker: confirm every branch defers or throws and none
   writes through in plaintext. (`C1`/`C13`)
6. `MIN_APP_VERSION` residual window from long-lived PowerSync tokens. (`C12`)
