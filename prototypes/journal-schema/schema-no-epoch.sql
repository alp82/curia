-- The alternative measured against `schema.sql`: the same table with NO epoch
-- column and no trigger. Every "since the epoch" question then carries its own
-- subquery for the epoch, which is what the queries in `queries.mjs` marked
-- `noEpochSql` type out. Kept so the cost of the stamp is a number and not an
-- argument.

create table events (
  id     integer primary key,
  ts     text    not null,
  type   text    not null,
  ticket text,
  agent  text,
  body   text    not null
) strict;

create index events_ticket_type on events (ticket, type, id);
create index events_agent_type  on events (agent, type, id);
create index events_type on events (type, id);
