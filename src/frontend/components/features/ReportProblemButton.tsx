'use client';

// "Report a problem" — sends Swiggy's report_error (on the service's own MCP
// server) for an error the user just saw, only when they tap it. Swiggy logs
// the report and returns a pre-filled mailto: link + summary, shown inline so
// the user can also email it. One report per error (the button disappears).

import { useState } from 'react';
import type { DomainService } from '@/shared/types';

export interface ReportProblemButtonProps {
  service: DomainService;
  tool: string; // the Swiggy tool that failed, e.g. "book_table"
  errorMessage: string;
  flowDescription?: string;
  toolContext?: Record<string, string | number | undefined>;
  reportId?: string; // Swiggy's error.reportId, when it gave one
  className?: string;
}

export function ReportProblemButton({
  service,
  tool,
  errorMessage,
  flowDescription,
  toolContext,
  reportId,
  className = '',
}: ReportProblemButtonProps) {
  const [state, setState] = useState<'idle' | 'sending' | 'sent' | 'failed'>('idle');
  const [result, setResult] = useState<{ summary?: string; reportLink?: string; message?: string }>({});

  const send = async () => {
    setState('sending');
    try {
      const ctx: Record<string, string> = {};
      for (const [k, v] of Object.entries(toolContext ?? {})) {
        if (v !== undefined && v !== '') ctx[k] = String(v);
      }
      const res = await fetch('/api/report-error', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ service, tool, errorMessage, flowDescription, toolContext: ctx, reportId }),
      });
      const data = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        summary?: string;
        reportLink?: string;
        message?: string;
      };
      setResult(data);
      setState(data.ok ? 'sent' : 'failed');
    } catch {
      setResult({ message: 'Could not reach the server.' });
      setState('failed');
    }
  };

  if (state === 'sent') {
    return (
      <div className={`mt-1.5 text-[11px] text-muted ${className}`}>
        <span className="font-semibold text-accent-teal">Reported to Swiggy.</span>{' '}
        {result.reportLink && (
          <a href={result.reportLink} className="font-semibold text-coral hover:underline">
            Email the report →
          </a>
        )}
      </div>
    );
  }
  return (
    <div className={`mt-1.5 text-[11px] ${className}`}>
      <button
        type="button"
        onClick={send}
        disabled={state === 'sending'}
        className="font-semibold text-muted underline-offset-2 hover:text-coral hover:underline disabled:opacity-50"
      >
        {state === 'sending' ? 'Reporting…' : 'Report a problem'}
      </button>
      {state === 'failed' && result.message && <span className="ml-1.5 text-muted">({result.message})</span>}
    </div>
  );
}

export default ReportProblemButton;
