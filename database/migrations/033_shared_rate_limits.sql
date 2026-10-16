-- ==============================================================================
-- 033  Shared request-rate counters
--
-- With several API processes behind a load balancer, per-process in-memory counters let a client send N times the allowance. These counters
-- live in one UNLOGGED table (fast, not WAL-logged, safe to lose on a crash) that is touched only through one atomic function, so every
-- process enforces the same limit. Enabled with RATE_LIMIT_STORE=postgres; the in-memory limiter stays the default for a single process.
-- ==============================================================================
CREATE UNLOGGED TABLE IF NOT EXISTS rate_buckets (
    key        text PRIMARY KEY,
    tokens     double precision NOT NULL,
    updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
ALTER TABLE rate_buckets ENABLE ROW LEVEL SECURITY;  -- no policy: nothing but the owner-run functions below can read or write it
REVOKE ALL ON rate_buckets FROM PUBLIC, crm_app_user, crm_worker;

-- Token bucket: refill for the time since the last call (capped at capacity), then take `p_cost` if there is enough.
CREATE OR REPLACE FUNCTION app.rate_take(p_key text, p_capacity double precision, p_refill double precision, p_cost double precision)
RETURNS TABLE (allowed boolean, remaining integer, retry_after integer)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $fn$
DECLARE
    v_now timestamptz := clock_timestamp();
    v_tokens double precision;
BEGIN
    IF p_capacity <= 0 OR p_refill <= 0 OR p_cost <= 0 OR length(p_key) > 200 THEN
        RAISE EXCEPTION 'invalid rate limit arguments';
    END IF;
    INSERT INTO rate_buckets AS b (key, tokens, updated_at) VALUES (p_key, p_capacity, v_now)
    ON CONFLICT (key) DO UPDATE
        SET tokens = LEAST(p_capacity, b.tokens + GREATEST(0, extract(epoch FROM (v_now - b.updated_at))) * p_refill), updated_at = v_now
    RETURNING b.tokens INTO v_tokens;
    IF v_tokens >= p_cost THEN
        UPDATE rate_buckets SET tokens = tokens - p_cost WHERE key = p_key;
        RETURN QUERY SELECT true, floor(v_tokens - p_cost)::integer, 0;
    ELSE
        RETURN QUERY SELECT false, 0, ceil((p_cost - v_tokens) / p_refill)::integer;
    END IF;
END
$fn$;
REVOKE ALL ON FUNCTION app.rate_take(text, double precision, double precision, double precision) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.rate_take(text, double precision, double precision, double precision) TO crm_app_user, crm_worker;

-- Buckets idle for a day are full again by definition; forget them so the table stays small.
CREATE OR REPLACE FUNCTION app.rate_purge() RETURNS integer
LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS $fn$
    WITH d AS (DELETE FROM rate_buckets WHERE updated_at < clock_timestamp() - interval '1 day' RETURNING 1) SELECT count(*)::integer FROM d;
$fn$;
REVOKE ALL ON FUNCTION app.rate_purge() FROM PUBLIC, crm_app_user;
GRANT EXECUTE ON FUNCTION app.rate_purge() TO crm_worker;
-- ==============================================================================
-- END OF MIGRATION 033
-- ==============================================================================
