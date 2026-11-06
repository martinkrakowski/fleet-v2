import Link from "next/link";
import { Badge, EmptyState, PageHeader, RouteChip } from "@fleet/ui";
import type { TodoData } from "./live";
import {
  TODO_GROUPS,
  TODO_GROUP_TITLES,
  groupTodoEntries,
  todoAgeText,
  todoClosedByText,
  todoRowHref,
  todoRowLabel,
  todoUnreadSources,
} from "./todo-model";
import classes from "./todo.module.css";

export function TodoView({ data }: { data: TodoData }) {
  if (data.view === "empty") {
    return (
      <div className={classes.page}>
        <EmptyState
          title="No owner to-dos are recorded on this station."
          actions={
            <RouteChip>live · GET /v1/todo · 0 rows</RouteChip>
          }
        />
      </div>
    );
  }

  if (data.view === "error") {
    return (
      <div className={classes.page}>
        <p className={classes.muted}>{data.reason}</p>
        <RouteChip variant="gap">error · not read</RouteChip>
      </div>
    );
  }

  if (data.view === "not-configured") {
    return (
      <div className={classes.page}>
        <p className={classes.muted}>
          GET /v1/todo is not served yet, so no to-do list was read. There is
          no sample to-do list.
        </p>
        <RouteChip variant="gap">not configured · not read</RouteChip>
      </div>
    );
  }

  const list = data.list;
  const groups = groupTodoEntries(list.entries);
  const unread = todoUnreadSources(list);

  return (
    <div className={classes.page}>
      <PageHeader
        title="To-do"
        description="What is waiting on the owner, read from GET /v1/todo. Read-only: nothing here merges, decides, approves or grants anything."
        actions={
          <RouteChip>
            live · GET /v1/todo · {list.entries.length} rows
          </RouteChip>
        }
      />
      {typeof list.parksWithoutItem === "number" &&
      list.parksWithoutItem > 0 ? (
        <p className={classes.muted}>
          {list.parksWithoutItem} parks without an owner item: see the board
        </p>
      ) : null}
      {!list.complete ? (
        <p className={classes.muted}>
          Unread sources: {unread.join(", ")}
        </p>
      ) : null}
      <div className={classes.groups}>
        {TODO_GROUPS.map((group) => (
          <section key={group} className={classes.group}>
            <h2 className={classes.groupTitle}>
              {TODO_GROUP_TITLES[group]} ({groups[group].length})
            </h2>
            <ol className={classes.list}>
              {groups[group].map((entry) => {
                const href = todoRowHref(entry);
                return (
                  <li key={entry.id} className={classes.row}>
                    <Badge>{todoRowLabel(entry)}</Badge>
                    {href !== null ? (
                      <Link href={href} className={classes.subject}>
                        {entry.subject}
                      </Link>
                    ) : (
                      <span className={classes.subject}>{entry.subject}</span>
                    )}
                    <p className={classes.rowMeta}>
                      {entry.projectId ?? "no project"} ·{" "}
                      {todoAgeText(entry.ageDays)} ·{" "}
                      {todoClosedByText(entry.closedBy)}
                    </p>
                    {entry.commands.length > 0 ? (
                      <div className={classes.commands}>
                        {entry.commands.map((command, index) => (
                          <code key={index} className={classes.command}>
                            {command}
                          </code>
                        ))}
                      </div>
                    ) : null}
                  </li>
                );
              })}
            </ol>
          </section>
        ))}
      </div>
    </div>
  );
}
