---
"@thomasfosterau/effect-drizzle-ext": patch
"@thomasfosterau/effect-drizzle-ext-pg": patch
---

`findPgError`, `classifyError`, `isUniqueViolation`, `isConstraintViolation`, `isRetryableTransactionFailure` (`./errors`) and `isRetryableConnectFailure` (`-pg/testing`) name their parameter `cause`: any caught failure value, walked as an error graph. The type (`unknown`) and behaviour are unchanged.
