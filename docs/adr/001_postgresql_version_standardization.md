# ADR 001: Standardization on PostgreSQL 17 for Local Development and Production Target

## Status
Accepted

## Context
The initial Master Engineering Directive draft specified PostgreSQL 16 as a preliminary baseline. During repository environment discovery in Execution 1, an active, healthy container running PostgreSQL 17.11 (`postgres:17`) was identified on loopback port 5442.

## Decision
We standardize on **PostgreSQL 17** across local development, automated integration testing, and the production target topology for the following reasons:
1. **Full Backwards Compatibility:** PostgreSQL 17 supports all standard SQL constructs, extensions (`uuid-ossp`, `pgcrypto`, `citext`), and RLS policies utilized by Anibros CRM.
2. **Improved Performance & Storage:** PostgreSQL 17 provides enhanced JSONB subscripting, improved vacuuming, and optimized memory management for multi-tenant analytical queries.
3. **Parity:** Using PostgreSQL 17 consistently across local development (`docker-compose.yml`), disposable test containers (`anibros_test`), and future production Docker deployments eliminates cross-version schema drift.

## Consequences
- `docker-compose.yml` pins `postgres:17`.
- Local tests run against PostgreSQL 17.11 on `127.0.0.1:5442`.
- Production deployment runbook specifies PostgreSQL 17.
