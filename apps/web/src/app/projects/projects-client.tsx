"use client";

import { useState } from "react";
import Link from "next/link";
import {
  Badge,
  Card,
  CardBody,
  CardHeader,
  EmptyState,
  PageHeader,
  RouteChip,
  Select,
  Table,
  TableContainer,
  Tbody,
  Td,
  Th,
  Thead,
  Tr,
} from "@fleet/ui";
import type { ProjectsData } from "./live";
import { worstProbeResult } from "./map-project";
import { NOT_CONFIGURED_REASON, useAutoRefresh } from "../lanes/use-auto-refresh";
import styles from "./projects.module.css";

type StatusFilter = "all" | "active" | "retired";

export function ProjectsClient({ data }: { data: ProjectsData }) {
  useAutoRefresh(data.source, data.fallbackReason);
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");

  const rows = data.projects.filter(
    (project) => statusFilter === "all" || project.status === statusFilter,
  );

  return (
    <div className={styles.page} data-contained-scroll>
      <PageHeader
        title="Projects"
        description={
          data.source === "api" ? (
            <>
              One row per registered project profile. The status filter is view
              state only; the table is a recorded read of{" "}
              <b>GET /v1/projects</b>, never a live runner observation. Retired
              profiles stay listed.
            </>
          ) : (
            <>
              The rows are sample data, not a live read of{" "}
              <b>GET /v1/projects</b>. The status filter is view state only.
              Retired profiles stay listed.
            </>
          )
        }
        actions={
          data.source === "api" ? (
            <RouteChip>
              live · GET /v1/projects · {data.projects.length} projects
            </RouteChip>
          ) : (
            <RouteChip variant="gap">fixture · {data.fallbackReason}</RouteChip>
          )
        }
      />
      <p className={styles.meta}>
        {data.source === "api"
          ? `Recorded state, not a runner observation · read ${data.observedAtIso} · refreshes every 30 s`
          : `Sample data, not this station · read ${data.observedAtIso}${
              data.fallbackReason !== NOT_CONFIGURED_REASON
                ? " · the API did not answer; retrying every 30 s"
                : ""
            }`}
      </p>
      <Card className={styles.listCard}>
        <CardHeader
          title="Profiles"
          actions={
            <Select
              inline
              aria-label="Status filter"
              value={statusFilter}
              onChange={(event) =>
                setStatusFilter(event.target.value as StatusFilter)
              }
            >
              <option value="all">All statuses</option>
              <option value="active">Active</option>
              <option value="retired">Retired</option>
            </Select>
          }
        />
        <CardBody
          className={styles.tableScroll}
          tabIndex={0}
          role="region"
          aria-label="Projects"
        >
          {rows.length > 0 ? (
            <TableContainer>
              <Table>
                <Thead>
                  <Tr>
                    <Th>Id</Th>
                    <Th>Display name</Th>
                    <Th>Status</Th>
                    <Th align="right">Revision</Th>
                    <Th>Repository</Th>
                    <Th>Worst probe</Th>
                    <Th>Last probe</Th>
                  </Tr>
                </Thead>
                <Tbody>
                  {rows.map((project) => {
                    const worst = worstProbeResult(project.lastProbe);
                    return (
                      <Tr key={project.projectId}>
                        <Td mono>
                          <Link
                            href={`/projects/${encodeURIComponent(project.projectId)}`}
                          >
                            {project.projectId}
                          </Link>
                        </Td>
                        <Td>{project.displayName}</Td>
                        <Td>
                          <Badge
                            variant={
                              project.status === "active" ? "active" : "ended"
                            }
                          >
                            {project.status}
                          </Badge>
                        </Td>
                        <Td align="right" mono>
                          {project.revision}
                        </Td>
                        <Td mono>{project.repository}</Td>
                        <Td>{worst}</Td>
                        <Td mono>
                          {project.lastProbe?.probedAtIso ?? "never"}
                        </Td>
                      </Tr>
                    );
                  })}
                </Tbody>
              </Table>
            </TableContainer>
          ) : (
            <EmptyState
              title="No profiles match this filter."
              description={
                <>
                  {data.projects.length} profile
                  {data.projects.length === 1 ? "" : "s"} in total; the status
                  filter hides the rest. Retired profiles stay in the table.
                </>
              }
            />
          )}
        </CardBody>
      </Card>
    </div>
  );
}
