"use client";

import { Button, Card, CardBody, CardHeader } from "@fleet/ui";
import type { CliHint } from "../live-view";
import styles from "../attempt.module.css";

export function LiveOperationsCard({
  hints,
  onCopied,
}: {
  hints: readonly CliHint[];
  onCopied: (message: string) => void;
}) {
  async function copy(hint: CliHint): Promise<void> {
    try {
      await navigator.clipboard.writeText(hint.command);
      onCopied(`Copied: ${hint.command}`);
    } catch {
      onCopied("Copy failed; select the command text instead");
    }
  }

  return (
    <Card>
      <CardHeader title="Operations" subtitle="read-only · no web write route yet" />
      <CardBody>
        <p>
          This page changes nothing. Copy a command and run it with the fleet-v2
          CLI (add <code>--state-dir &lt;path&gt;</code> when your installation
          uses one). Whether an operation is allowed is decided by the CLI and
          the API, not by this page.
        </p>
        {hints.map((hint) => (
          <div key={hint.op} className={styles.cliHint}>
            <b>{hint.label}</b>
            <p>{hint.does}</p>
            <p>{hint.doesNot}</p>
            {hint.disabledReason !== null ? (
              <div className={styles.cliCommand} aria-disabled="true">
                <code>{hint.command}</code>
              </div>
            ) : (
              <div className={styles.cliCommand}>
                <code>{hint.command}</code>
              </div>
            )}
            {hint.disabledReason !== null ? (
              <p className={styles.cliDisabled}>{hint.disabledReason}</p>
            ) : null}
            <Button
              variant="outline"
              disabled={hint.disabledReason !== null}
              aria-label={`Copy command: ${hint.command}`}
              onClick={() => void copy(hint)}
            >
              Copy
            </Button>
          </div>
        ))}
      </CardBody>
    </Card>
  );
}
