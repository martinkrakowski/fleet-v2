"use client";

import Link from "next/link";
import {
  Badge,
  Banner,
  Card,
  CardBody,
  CardHeader,
  KeyValueList,
  KeyValueRow,
  PageHeader,
  RouteChip,
} from "@fleet/ui";
import type { ProjectDetailData } from "../live";
import { worstProbeResult } from "../map-project";
import { NOT_CONFIGURED_REASON, useAutoRefresh } from "../../lanes/use-auto-refresh";
import styles from "../projects.module.css";

export function ProjectDetailClient({
  projectId,
  data,
}: {
  projectId: string;
  data: ProjectDetailData;
}) {
  useAutoRefresh(data.source, data.fallbackReason);

  if (data.project === null && data.source === "api") {
    return (
      <div className={styles.page} data-contained-scroll>
        <PageHeader
          title="Project not registered"
          description={
            <>
              The API answered <b>404 NOT_FOUND</b> for <b>{projectId}</b> —
              live, not sample data. Register it first, then it will appear on{" "}
              <Link href="/projects">/projects</Link>.
            </>
          }
          actions={
            <RouteChip>live · GET /v1/projects/{projectId}</RouteChip>
          }
        />
        <Banner tone="warn" title={`${projectId} is not registered.`}>
          <p>
            Use <code>fleet-v2 projects add</code> for a new project profile, or{" "}
            <code>fleet-v2 projects adopt</code> to register a project that
            already has work orders. Writes from the web arrive with the web
            write path; use the CLI meanwhile.
          </p>
        </Banner>
      </div>
    );
  }

  const project = data.project;
  if (project === null) {
    const reason =
      data.fallbackReason ?? "the api client gave no fallback reason";
    return (
      <div className={styles.page} data-contained-scroll>
        <PageHeader
          title="Project not in sample data"
          description={
            <>
              <b>{projectId}</b> is not in the sample data (the API is not answering: {reason}). See the sample profiles on{" "}
              <Link href="/projects">/projects</Link>.
            </>
          }
          actions={
            <RouteChip variant="gap">fixture · {reason}</RouteChip>
          }
        />
        <Banner
          tone="warn"
          title={`${projectId} is not in the sample data (the API is not answering: ${reason}).`}
        >
          <p>
            Whether <b>{projectId}</b> is registered on this station cannot be
            read while the API is not answering ({reason}).
          </p>
        </Banner>
      </div>
    );
  }

  const worst = worstProbeResult(project.lastProbe);

  return (
    <div className={styles.page} data-contained-scroll>
      <PageHeader
        pretitle={<span className={styles.meta}>{project.projectId}</span>}
        title={project.displayName}
        description={
          data.source === "api" ? (
            <>
              The recorded profile for <b>{project.projectId}</b>, read live from{" "}
              <b>GET /v1/projects/{projectId}</b>. Nothing here writes.
            </>
          ) : (
            <>
              Sample profile for <b>{project.projectId}</b> — the rows are sample data,
              not a live read of <b>GET /v1/projects/{projectId}</b>. Nothing here writes.
            </>
          )
        }
        actions={
          <>
            {data.source === "api" ? (
              <RouteChip>
                live · GET /v1/projects/{projectId} · {project.displayName}
              </RouteChip>
            ) : (
              <RouteChip variant="gap">fixture · {data.fallbackReason}</RouteChip>
            )}
            <Link
              className={styles.lanesLink}
              href={`/lanes?project=${encodeURIComponent(project.projectId)}`}
            >
              Lanes for this project
            </Link>
          </>
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
      <div
        className={styles.stack}
        tabIndex={0}
        role="region"
        aria-label="Project profile"
      >
        <Card>
          <CardHeader title="Profile" />
          <CardBody>
            <KeyValueList>
              <KeyValueRow term="Id" mono>
                {project.projectId}
              </KeyValueRow>
              <KeyValueRow term="Display name">{project.displayName}</KeyValueRow>
              <KeyValueRow term="Repository" mono>
                {project.repository}
              </KeyValueRow>
              <KeyValueRow term="Designated dispatcher host" mono>
                {project.designatedDispatcherHost}
              </KeyValueRow>
              <KeyValueRow term="Policy revision" mono>
                {project.policyRevision}
              </KeyValueRow>
              <KeyValueRow term="Max concurrent lanes">
                {project.maxConcurrentLanes}
              </KeyValueRow>
              <KeyValueRow term="Revision" mono>
                {project.revision}
              </KeyValueRow>
              <KeyValueRow term="Default branch" mono>
                {project.defaultBranch ?? "none"}
              </KeyValueRow>
              <KeyValueRow term="Status">
                <Badge variant={project.status === "active" ? "active" : "ended"}>
                  {project.status}
                </Badge>
              </KeyValueRow>
              <KeyValueRow term="Runner capabilities" mono>
                {Object.keys(project.runnerCapabilities).length === 0
                  ? "none"
                  : Object.entries(project.runnerCapabilities)
                      .map(([name, value]) => `${name}: ${String(value)}`)
                      .join("\n")}
              </KeyValueRow>
              <KeyValueRow term="Updated at" mono>
                {project.updatedAtIso}
              </KeyValueRow>
            </KeyValueList>
          </CardBody>
        </Card>

        <Card>
          <CardHeader title="Clones" />
          <CardBody>
            {Object.keys(project.clones).length === 0 ? (
              <p className={styles.notice}>No clones configured.</p>
            ) : (
              <ul className={styles.cloneList}>
                {Object.entries(project.clones).map(([host, clone]) => (
                  <li key={host} className={styles.cloneLine}>
                    {host}: {clone.path} (worktrees {clone.worktreeRoot})
                  </li>
                ))}
              </ul>
            )}
          </CardBody>
        </Card>

        <Card>
          <CardHeader title="Gate procedures" />
          <CardBody>
            {project.gateProcedures.length === 0 ? (
              <p className={styles.notice}>No gate procedures configured.</p>
            ) : (
              <ul className={styles.cloneList}>
                {project.gateProcedures.map((name) => (
                  <li key={name} className={styles.cloneLine}>
                    {name}
                  </li>
                ))}
              </ul>
            )}
          </CardBody>
        </Card>

        <Card>
          <CardHeader title="Allowed path prefixes" />
          <CardBody>
            {project.defaultAllowedPathPrefixes.length === 0 ? (
              <p className={styles.notice}>No default allowed path prefixes.</p>
            ) : (
              <ul className={styles.cloneList}>
                {project.defaultAllowedPathPrefixes.map((prefix) => (
                  <li key={prefix} className={styles.cloneLine}>
                    {prefix}
                  </li>
                ))}
              </ul>
            )}
          </CardBody>
        </Card>

        <Card>
          <CardHeader
            title="Last probe"
            subtitle={
              project.lastProbe
                ? `${project.lastProbe.probedAtIso} · probed from ${project.lastProbe.probedFrom} · worst check ${worst}`
                : "never probed"
            }
          />
          <CardBody>
            {project.lastProbe === null ? (
              <p className={styles.notice}>Never probed.</p>
            ) : (
              <pre className={styles.probeLines}>
                {project.lastProbe.checks
                  .map(
                    (check) =>
                      `${check.result}  ${check.name}  ${
                        check.host ?? "-"
                      }  ${check.detail}`,
                  )
                  .join("\n")}
              </pre>
            )}
          </CardBody>
        </Card>

        <Card>
          <CardHeader title="Actions" subtitle="CLI commands for this project" />
          <CardBody>
            <p className={styles.notice}>
              Writes from the web arrive with the web write path; use the CLI
              meanwhile.
            </p>
            <pre className={styles.code}>
              <code>fleet-v2 projects probe {project.projectId}</code>
            </pre>
            <pre className={styles.code}>
              <code>fleet-v2 projects edit {project.projectId}</code>
            </pre>
            <pre className={styles.code}>
              <code>fleet-v2 projects retire {project.projectId}</code>
            </pre>
          </CardBody>
        </Card>
      </div>
    </div>
  );
}
