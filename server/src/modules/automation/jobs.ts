import type { Database } from '../../platform/db';
import type { JobHandler } from '../../platform/jobs';
import { ContactsService } from '../contacts/service';
import { LeadsService } from '../leads/service';
import { TasksService } from '../tasks/service';
import { createAutomationHandlers } from './engine';

/**
 * Job handlers for the worker. Services are built from the job's own database handle (the worker's restricted role), like the
 * inbound processor does, so the worker never touches the API's connection pool.
 */
const cache = new WeakMap<Database, ReturnType<typeof createAutomationHandlers>>();
function handlersFor(db: Database) {
  let h = cache.get(db);
  if (!h) {
    h = createAutomationHandlers({ leads: new LeadsService(db, new ContactsService(db)), tasks: new TasksService(db) });
    cache.set(db, h);
  }
  return h;
}

export const automationJobHandlers: Record<string, JobHandler> = {
  'automation.dispatch': (job, ctx) => handlersFor(ctx.db).dispatch(job, ctx),
  'automation.retry': (job, ctx) => handlersFor(ctx.db).retry(job, ctx),
};
