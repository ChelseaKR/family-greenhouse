import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { ClipboardDocumentIcon, KeyIcon, TrashIcon } from '@heroicons/react/24/outline';
import { householdService, type CreatedSitterLink } from '@/services/householdService';
import { Card, CardHeader } from '@/components/Card';
import { Button } from '@/components/Button';
import { Input } from '@/components/Input';
import { Alert } from '@/components/Alert';
import { getErrorMessage } from '@/services/api';

/**
 * Admin-only UI to create, copy, and revoke no-account plant-sitter links.
 * Mirrors the invite-link pattern: the secret token/URL is shown exactly once
 * (right after creation) and never again — the list only shows the link's
 * window + status, so a leaked screenshot of the management page can't be used
 * to access the household. Revoking flips a link to inactive immediately.
 */
export function SitterLinksCard({ householdId }: { householdId: string }) {
  const queryClient = useQueryClient();
  const [created, setCreated] = useState<CreatedSitterLink | null>(null);
  const [copied, setCopied] = useState(false);
  // Default the window to two weeks out — a typical trip length.
  const [days, setDays] = useState('14');
  const [label, setLabel] = useState('');

  const linksQuery = useQuery({
    queryKey: ['sitter-links', householdId],
    queryFn: () => householdService.listSitterLinks(householdId),
  });

  const createMutation = useMutation({
    mutationFn: () => {
      const n = Math.max(1, Math.min(60, parseInt(days, 10) || 14));
      const expiresAt = new Date(Date.now() + n * 24 * 60 * 60 * 1000).toISOString();
      return householdService.createSitterLink(householdId, {
        expiresAt,
        label: label.trim() || undefined,
      });
    },
    onSuccess: (link) => {
      setCreated(link);
      setCopied(false);
      setLabel('');
      queryClient.invalidateQueries({ queryKey: ['sitter-links', householdId] });
    },
  });

  const revokeMutation = useMutation({
    mutationFn: (linkId: string) => householdService.revokeSitterLink(householdId, linkId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['sitter-links', householdId] });
    },
  });

  const handleCopy = async () => {
    if (created) {
      await navigator.clipboard.writeText(created.url);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  };

  const activeLinks = (linksQuery.data ?? []).filter((l) => l.status === 'active');

  return (
    <Card>
      <CardHeader
        title="Plant-sitter links"
        description="Going away? Share a temporary link so a neighbour or friend can see what needs care and check it off — no account needed. The link expires on its own, and you can revoke it any time."
      />

      {created ? (
        <div className="space-y-3">
          <Alert variant="success" title="Your sitter link is ready">
            Copy it now — for security, we won’t show the full link again. You can always create a
            new one.
          </Alert>
          <div className="flex items-center gap-2">
            <input
              type="text"
              readOnly
              value={created.url}
              className="input flex-1 bg-gray-50"
              aria-label="Plant-sitter link"
            />
            <Button
              variant="secondary"
              onClick={handleCopy}
              leftIcon={<ClipboardDocumentIcon className="h-4 w-4" aria-hidden="true" />}
            >
              {copied ? 'Copied!' : 'Copy'}
            </Button>
          </div>
          <p className="text-xs text-gray-600">
            Expires {new Date(created.expiresAt).toLocaleDateString()}.
          </p>
          <Button variant="secondary" size="sm" onClick={() => setCreated(null)}>
            Done
          </Button>
        </div>
      ) : (
        <form
          className="space-y-3"
          onSubmit={(e) => {
            e.preventDefault();
            createMutation.mutate();
          }}
        >
          <div className="grid gap-3 sm:grid-cols-2">
            <Input
              label="Lasts for (days)"
              type="number"
              min={1}
              max={60}
              value={days}
              onChange={(e) => setDays(e.target.value)}
              helperText="Up to 60 days."
            />
            <Input
              label="Label (optional)"
              placeholder="e.g. The Smiths’ plants"
              value={label}
              maxLength={60}
              onChange={(e) => setLabel(e.target.value)}
              helperText="A friendly name your sitter sees. No personal details."
            />
          </div>
          <Button
            type="submit"
            isLoading={createMutation.isPending}
            leftIcon={<KeyIcon className="h-4 w-4" aria-hidden="true" />}
          >
            Create sitter link
          </Button>
        </form>
      )}

      {createMutation.isError && (
        <Alert variant="error" className="mt-4">
          {getErrorMessage(createMutation.error)}
        </Alert>
      )}

      {activeLinks.length > 0 && (
        <div className="mt-6">
          <h3 className="text-sm font-medium text-gray-900">Active links</h3>
          <ul className="mt-2 divide-y divide-primary-100/60 rounded-lg border border-primary-100/70">
            {activeLinks.map((link) => (
              <li key={link.id} className="flex items-center justify-between gap-4 px-4 py-3">
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium text-gray-900">
                    {link.label || 'Sitter link'}
                  </p>
                  <p className="text-xs text-gray-600">
                    Expires {new Date(link.expiresAt).toLocaleDateString()}
                  </p>
                </div>
                <Button
                  variant="secondary"
                  size="sm"
                  isLoading={revokeMutation.isPending && revokeMutation.variables === link.id}
                  onClick={() => revokeMutation.mutate(link.id)}
                  leftIcon={<TrashIcon className="h-4 w-4 text-red-500" aria-hidden="true" />}
                  aria-label={`Revoke sitter link ${link.label || ''}`.trim()}
                >
                  Revoke
                </Button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </Card>
  );
}
