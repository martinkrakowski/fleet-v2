"use client";

import { Card, CardBody, CardHeader, KeyValueList, KeyValueRow, RouteChip } from "@fleet/ui";

export interface BriefManifestCardProps {
  woId: string;
  manifest: Record<string, string> | undefined;
}

export function BriefManifestCard({ woId, manifest }: BriefManifestCardProps) {
  return (
    <Card>
      <CardHeader
        title="Manifest"
        subtitle={woId}
        actions={<RouteChip gap>gap · no package read</RouteChip>}
      />
      <CardBody>
        {manifest ? (
          <KeyValueList>
            {Object.entries(manifest).map(([key, value]) => (
              <KeyValueRow key={key} term={key}>
                {value}
              </KeyValueRow>
            ))}
          </KeyValueList>
        ) : (
          <RouteChip gap>gap · no package read</RouteChip>
        )}
      </CardBody>
    </Card>
  );
}
