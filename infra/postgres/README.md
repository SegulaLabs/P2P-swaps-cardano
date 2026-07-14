# PostgreSQL

The schema is NOT duplicated here — the compose file mounts
[`backend/src/db/schema.sql`](../../backend/src/db/schema.sql) into
`/docker-entrypoint-initdb.d/`, so it runs on the container's **first** boot
only.

To reapply after schema changes during development:

```bash
docker compose -f infra/docker-compose.yml down -v   # wipes data!
docker compose -f infra/docker-compose.yml up -d
```

(Real migrations — e.g. node-pg-migrate or dbmate — come when the schema
stabilizes; a cache DB that can be rebuilt from chain keeps this cheap.)
