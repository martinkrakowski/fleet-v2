"use client";

import { useEffect, useId, useRef } from 'react';
import type { CSSProperties, ReactNode } from 'react';
import { Button } from './Button';
import { toneClassKey, type SemanticTone } from './tone';
import classes from './AlertBox.module.css';

export interface AlertBoxProps {
  open: boolean;
  tone?: SemanticTone;
  title: ReactNode;
  meta?: ReactNode;
  children: ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  confirmDisabled?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
  className?: string;
  style?: CSSProperties;
}

export function AlertBox({
  open,
  tone = 'neutral',
  title,
  meta,
  children,
  confirmLabel = 'Confirm',
  cancelLabel = 'Cancel',
  confirmDisabled = false,
  onConfirm,
  onCancel,
  className,
  style,
}: AlertBoxProps) {
  const titleId = useId();
  const bodyId = useId();

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onCancel();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [open, onCancel]);

  const previousFocusRef = useRef<HTMLElement | null>(null);
  const cancelButtonRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    if (!open) return;
    previousFocusRef.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    cancelButtonRef.current?.focus();
    return () => {
      previousFocusRef.current?.focus();
      previousFocusRef.current = null;
    };
  }, [open]);

  if (!open) return null;

  const toneKey = toneClassKey(tone);
  return (
    <div
      className={classes.backdrop}
      role="presentation"
      style={style}
      onClick={onCancel}
    >
      <div
        role="alertdialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={bodyId}
        className={[classes.dialog, classes[toneKey] ?? classes.toneNeutral, className]
          .filter(Boolean)
          .join(' ') || undefined}
        onClick={(event) => event.stopPropagation()}
      >
        <p className={classes.title} id={titleId}>
          {title}
        </p>
        <div className={classes.body} id={bodyId}>
          {children}
        </div>
        <div className={classes.footer}>
          {meta != null ? <span className={classes.meta}>{meta}</span> : null}
          <div className={classes.actions}>
            <Button ref={cancelButtonRef} variant="outline" tone="neutral" size="sm" onClick={onCancel}>
              {cancelLabel}
            </Button>
            <Button
              variant="solid"
              tone={tone === 'neutral' ? 'accent' : tone}
              size="sm"
              disabled={confirmDisabled}
              onClick={onConfirm}
            >
              {confirmLabel}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}