import type {
  ReactNode,
  TableHTMLAttributes,
  ThHTMLAttributes,
  TdHTMLAttributes,
  HTMLAttributes,
} from 'react';
import classes from './Table.module.css';

export interface TableContainerProps extends HTMLAttributes<HTMLDivElement> {
  children: ReactNode;
}

export interface TableProps extends TableHTMLAttributes<HTMLTableElement> {
  stickyHeader?: boolean;
  children: ReactNode;
}

export interface TableSectionProps extends HTMLAttributes<HTMLTableSectionElement> {
  children: ReactNode;
}

export interface TableRowProps extends HTMLAttributes<HTMLTableRowElement> {
  children: ReactNode;
}

export interface TableHeadCellProps extends ThHTMLAttributes<HTMLTableCellElement> {
  mono?: boolean;
  strong?: boolean;
  align?: 'left' | 'right' | 'center';
  children?: ReactNode;
}

export interface TableCellProps extends TdHTMLAttributes<HTMLTableCellElement> {
  mono?: boolean;
  strong?: boolean;
  align?: 'left' | 'right' | 'center';
  children?: ReactNode;
}

function cellClasses(
  base: string,
  mono?: boolean,
  strong?: boolean,
  align?: 'left' | 'right' | 'center',
  className?: string,
): string | undefined {
  return (
    [
      base,
      mono ? classes.mono : null,
      strong ? classes.strong : null,
      align === 'right' ? classes.alignRight : null,
      align === 'center' ? classes.alignCenter : null,
      className,
    ]
      .filter(Boolean)
      .join(' ') || undefined
  );
}

export function TableContainer({ children, className, ...rest }: TableContainerProps) {
  return (
    <div className={[classes.container, className].filter(Boolean).join(' ')} {...rest}>
      {children}
    </div>
  );
}

export function Table({ stickyHeader = false, children, className, ...rest }: TableProps) {
  return (
    <table
      className={[classes.table, stickyHeader && classes.stickyHeader, className]
        .filter(Boolean)
        .join(' ') || undefined}
      {...rest}
    >
      {children}
    </table>
  );
}

export function Thead({ children, className, ...rest }: TableSectionProps) {
  return (
    <thead className={[classes.thead, className].filter(Boolean).join(' ') || undefined} {...rest}>
      {children}
    </thead>
  );
}

export function Tbody({ children, className, ...rest }: TableSectionProps) {
  return (
    <tbody className={[classes.tbody, className].filter(Boolean).join(' ') || undefined} {...rest}>
      {children}
    </tbody>
  );
}

export function Tr({ children, className, ...rest }: TableRowProps) {
  return (
    <tr className={[classes.row, className].filter(Boolean).join(' ') || undefined} {...rest}>
      {children}
    </tr>
  );
}

export function Th({
  mono,
  strong,
  align,
  className,
  children,
  ...rest
}: TableHeadCellProps) {
  return (
    <th
      scope="col"
      className={cellClasses(classes.headCell, mono, strong, align, className)}
      {...rest}
    >
      {children}
    </th>
  );
}

export function Td({ mono, strong, align, className, children, ...rest }: TableCellProps) {
  return (
    <td className={cellClasses(classes.cell, mono, strong, align, className)} {...rest}>
      {children}
    </td>
  );
}