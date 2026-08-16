-- The journal schema, prototyped for alp82/curia#321.
--
-- One table. 96 event types share it, because the boot replay reads every
-- event in write order and the fourteen questions all key by ticket, by agent
-- or by type. Ninety-six tables would make the operator's "last thirty events"
-- a ninety-six-way union.
--
-- STRICT is permitted: #320 ruled the operator's sqlite3 comes out of the
-- daemon image, which carries SQLite 3.53. The host's 3.31 does not read this
-- file and does not constrain it.

create table events (
  -- The write order. `id` IS the position the ten scans used when they said
  -- "after the epoch", so every ordering below is `order by id`, never by ts.
  -- Two events inside one millisecond keep their order.
  id     integer primary key,

  -- ISO-8601 UTC, exactly as `_append` stamps it.
  ts     text    not null,

  -- The event type, in TODAY's spelling. A line written before #184 says
  -- `worker_spawned` in `body` and `agent_spawned` here.
  type   text    not null,

  -- The ticket, as text. Null when the event names none (image builds, bridge
  -- health, deploys). Text and not integer, so `where ticket='320'` works —
  -- and `where ticket=320` works too, because SQLite applies the column's TEXT
  -- affinity to a bare numeric literal.
  ticket text,

  -- The agent session, in today's spelling. A pre-#184 line carries
  -- `"worker": "curia-170"` in `body` and `curia-170` here.
  agent  text,

  -- The dispatch this row belongs to: the id of the `dispatch_claimed` or
  -- `agent_spawned` row that opened the ticket's latest epoch at the moment
  -- this row was written. An epoch-opening row carries its own id. 0 for a row
  -- with no ticket, or one written before its ticket was ever dispatched.
  --
  -- This is the "after the epoch" of the three shapes, precomputed. Four of the
  -- fourteen questions become an equality on it, and the operator gets
  -- `where epoch=(select max(epoch) from events where ticket=321)` — one
  -- dispatch, whole, at 2 a.m.
  epoch  integer not null default 0,

  -- The line curia wrote, byte for byte, old spelling and all (ADR-0017).
  -- `select body from events order by id` regenerates events.jsonl.
  body   text    not null
) strict;

-- Shape A ("the last event of type T for key K") and the type-narrowed halves
-- of B and C. Both directions, because six of the fourteen key by agent.
create index events_ticket_type on events (ticket, type, id);
create index events_agent_type  on events (agent, type, id);

-- The current epoch of a ticket, as one index probe: the rightmost entry for
-- the ticket. Without it, `max(epoch)` reads every row the ticket ever wrote.
create index events_ticket_epoch on events (ticket, epoch);

-- Shapes B and C ("since the epoch"), and the operator's "this dispatch, whole".
create index events_epoch_type  on events (epoch, type);

-- The census, `group by type`. Also the type-only reads the reduction does at
-- boot for the recent-outcome rings.
create index events_type on events (type, id);

-- The epoch stamp is a property of the TABLE, not of the write path. 129
-- `logEvent` call sites stay ignorant of it, and a migrated row gets the same
-- stamp as a live one because both arrive through this trigger.
create trigger events_stamp_epoch after insert on events
when new.ticket is not null
begin
  update events set epoch = coalesce((
    select e.id from events e
     where e.ticket = new.ticket
       and e.type in ('dispatch_claimed', 'agent_spawned')
       and e.id <= new.id
     order by e.id desc limit 1
  ), 0)
  where id = new.id;
end;
