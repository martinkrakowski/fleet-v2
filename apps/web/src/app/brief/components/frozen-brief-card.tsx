"use client";

import {
  Banner,
  Button,
  Card,
  CardBody,
  CardFooter,
  CardHeader,
  KeyValueList,
  KeyValueRow,
  RouteChip,
} from "@fleet/ui";
import { md } from "../markdown";
import styles from "../brief.module.css";

export interface FrozenBriefCardProps {
  digest: string;
  frozenAt: string;
  original?: string;
  manifest: Record<string, string>;
  markdown: string;
  fresh: boolean;
  dispatched: boolean;
  onDispatch: () => void;
}

export function FrozenBriefCard({
  digest,
  frozenAt,
  original,
  manifest,
  markdown,
  fresh,
  dispatched,
  onDispatch,
}: FrozenBriefCardProps) {
  return (
    <Card>
      <CardHeader
        title="Frozen brief package"
        subtitle="locked · read-only"
        actions={<RouteChip gap>gap · no package read</RouteChip>}
      />
      <CardBody>
        <div className={styles.stamp}>
          <span>
            digest <b>{digest}</b>
          </span>
          <span>
            frozen <b>{frozenAt}</b>
          </span>
          {original ? (
            <span>
              original <b>{original}</b>
            </span>
          ) : null}
        </div>
        <KeyValueList>
          {Object.entries(manifest).map(([key, value]) => (
            <KeyValueRow key={key} term={key}>
              {value}
            </KeyValueRow>
          ))}
        </KeyValueList>
        <div className={styles.md} dangerouslySetInnerHTML={{ __html: md(markdown) }} />
      </CardBody>
      {fresh ? (
        <CardFooter>
          {dispatched ? (
            <Banner tone="warn" title="Dispatch was pressed.">
              No request left this station — the live freeze and dispatch routes are not on this
              station, so nothing was recorded.
            </Banner>
          ) : (
            <div className={styles.freezeBar}>
              <span className={styles.sum}>the package is frozen; the intent is not recorded yet</span>
              <Button variant="solid" tone="accent" onClick={onDispatch}>
                Dispatch the intent
              </Button>
              <RouteChip>POST /v1/attempts</RouteChip>
              <span className={styles.sum}>
                a separate step — the Line holds the intent until a slot frees
              </span>
            </div>
          )}
        </CardFooter>
      ) : (
        <CardFooter>
          <Banner tone="ok">
            Frozen and dispatched. The digest is the truth the runner was held to.
          </Banner>
        </CardFooter>
      )}
    </Card>
  );
}
