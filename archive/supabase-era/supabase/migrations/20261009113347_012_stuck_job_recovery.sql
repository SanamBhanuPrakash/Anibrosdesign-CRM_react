/*
# Stuck-Job Recovery

## Purpose
Reset webhook_inbox and outbox_events records stuck in 'processing' status
back to 'received'/'pending' so they can be retried by the worker.

## Functions
1. `reset_stuck_webhook_jobs(timeout_minutes int DEFAULT 10)` — resets processing webhook_inbox entries older than timeout
2. `reset_stuck_outbox_jobs(timeout_minutes int DEFAULT 10)` — resets processing outbox_events entries older than timeout

Both return the number of records reset.

## Security
- SECURITY DEFINER, EXECUTE authenticated only
- Explicit search_path
*/

CREATE OR REPLACE FUNCTION public.reset_stuck_webhook_jobs(p_timeout_minutes int DEFAULT 10)
RETURNS int
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  affected_count int;
BEGIN
  UPDATE webhook_inbox
  SET status = 'received',
      next_attempt_at = now(),
      error_detail = COALESCE(error_detail, '') || ' [auto-recovered from stuck processing]'
  WHERE status = 'processing'
    AND updated_at < (now() - (p_timeout_minutes || ' minutes')::interval);

  GET DIAGNOSTICS affected_count = ROW_COUNT;
  RETURN affected_count;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.reset_stuck_webhook_jobs(int) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.reset_stuck_webhook_jobs(int) FROM anon;
GRANT EXECUTE ON FUNCTION public.reset_stuck_webhook_jobs(int) TO authenticated;

CREATE OR REPLACE FUNCTION public.reset_stuck_outbox_jobs(p_timeout_minutes int DEFAULT 10)
RETURNS int
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  affected_count int;
BEGIN
  UPDATE outbox_events
  SET status = 'pending',
      next_attempt_at = now(),
      error_detail = COALESCE(error_detail, '') || ' [auto-recovered from stuck processing]'
  WHERE status = 'processing'
    AND updated_at < (now() - (p_timeout_minutes || ' minutes')::interval);

  GET DIAGNOSTICS affected_count = ROW_COUNT;
  RETURN affected_count;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.reset_stuck_outbox_jobs(int) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.reset_stuck_outbox_jobs(int) FROM anon;
GRANT EXECUTE ON FUNCTION public.reset_stuck_outbox_jobs(int) TO authenticated;
