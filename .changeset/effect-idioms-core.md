---
"@thomasfosterau/effect-drizzle-ext": minor
---

Add `retryTransaction` to `./errors`: piped onto a whole `transact(…)`, it re-runs the transaction on a jittered exponential backoff (default 3 retries from 50 ms) while it fails with a serialization failure (`40001`) or a deadlock (`40P01`), and passes every other failure through on the first attempt.

Add `decodeHexBytea` to `./columns`, a `Result`-returning hex decoder failing with `effect/encoding`'s `EncodingError`. `byteaToHex` and `hexToBytea` now run on `effect/encoding`'s `Hex` (about ten times faster); their results and `hexToBytea`'s `TypeError` on malformed input are unchanged.
