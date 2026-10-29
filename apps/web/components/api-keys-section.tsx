"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import {
  createApiKey,
  KEY_NAME_MAX,
  listApiKeys,
  revokeApiKey,
  validateKeyName,
  type ApiKeySummary,
} from "@/lib/api/keys";

const message = (e: unknown) => (e instanceof Error ? e.message : "Something went wrong.");

export function ApiKeysSection({ userId }: { userId: string }) {
  const qc = useQueryClient();
  const queryKey = ["api-keys", userId];
  const [name, setName] = useState("");
  const [nameError, setNameError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  // The secret lives only in this state, cleared when the dialog closes.
  const [secret, setSecret] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [toRevoke, setToRevoke] = useState<ApiKeySummary | null>(null);

  const keys = useQuery({ queryKey, queryFn: () => listApiKeys(), retry: false });

  const create = useMutation({
    mutationFn: (n: string) => createApiKey(n),
    onSuccess: (created) => {
      setSecret(created.key);
      setCopied(false);
      setName("");
      void qc.invalidateQueries({ queryKey });
    },
    onError: (e) => setActionError(message(e)),
    // Do not keep the secret in the mutation cache.
    gcTime: 0,
  });

  const revoke = useMutation({
    mutationFn: (id: string) => revokeApiKey(id),
    onSuccess: () => setToRevoke(null),
    onError: (e) => {
      setToRevoke(null);
      setActionError(message(e));
    },
    onSettled: () => void qc.invalidateQueries({ queryKey }),
  });

  const submit = (e: FormEvent) => {
    e.preventDefault();
    setActionError(null);
    const err = validateKeyName(name);
    setNameError(err);
    if (!err) create.mutate(name);
  };

  const closeSecret = () => {
    setSecret(null);
    setCopied(false);
    create.reset();
  };

  const copy = async () => {
    if (!secret) return;
    try {
      await navigator.clipboard.writeText(secret);
      setCopied(true);
    } catch {
      setActionError("Could not copy automatically. Select the key and copy it manually.");
    }
  };

  const origin = typeof window !== "undefined" ? window.location.origin : "https://<this-site>";
  const snippet = `curl -X POST ${origin}/api/select \\
  -H "x-api-key: qrb_…" \\
  -H "content-type: application/json" \\
  -d '{"circuit_qasm": "OPENQASM 3.0; qubit[2] q; h q[0]; cx q[0], q[1];"}'`;

  const error = actionError ?? (keys.isError ? message(keys.error) : null);

  return (
    <section aria-labelledby="keys-h" className="flex flex-col gap-3" data-section="api-keys">
      <h2 id="keys-h" className="text-subheading font-medium text-ink-primary">API keys</h2>
      <p className="text-body text-ink-secondary">
        Keys let scripts call the API as you; they draw from your quota. Revoke a key at any time.
      </p>

      {error && (
        <div role="alert" className="rounded-lg border border-violation bg-violation-dim p-3 text-body text-violation">
          {error}
        </div>
      )}

      <form onSubmit={submit} className="flex flex-col gap-1" noValidate>
        <label htmlFor="key-name" className="text-caption text-ink-tertiary">Key name</label>
        <div className="flex gap-2">
          <Input
            id="key-name"
            value={name}
            maxLength={KEY_NAME_MAX}
            placeholder="e.g. laptop script"
            aria-invalid={!!nameError}
            aria-describedby={nameError ? "key-name-err" : undefined}
            onChange={(e) => {
              setName(e.target.value);
              setNameError(null);
            }}
          />
          <Button type="submit" disabled={create.isPending}>
            {create.isPending ? "Creating…" : "Create key"}
          </Button>
        </div>
        {nameError && <p id="key-name-err" className="text-caption text-violation">{nameError}</p>}
      </form>

      {keys.isPending ? (
        <p className="text-body text-ink-tertiary">Loading keys…</p>
      ) : keys.data && keys.data.length === 0 ? (
        <p className="rounded-lg border border-dashed border-hairline p-4 text-body text-ink-tertiary">
          You have no API keys yet.
        </p>
      ) : (
        <ul className="divide-y divide-hairline rounded-lg border border-hairline">
          {(keys.data ?? []).map((k) => (
            <li key={k.id} className="flex items-center justify-between gap-4 px-4 py-3">
              <div className="min-w-0">
                <p className="truncate text-body font-medium text-ink-primary">{k.name}</p>
                <p className="text-caption text-ink-tertiary">
                  <code>{k.start}…</code> · created {new Date(k.createdAt).toLocaleDateString()}
                </p>
              </div>
              <Button type="button" variant="outline" disabled={revoke.isPending} onClick={() => setToRevoke(k)}>
                Revoke
              </Button>
            </li>
          ))}
        </ul>
      )}

      <div className="flex flex-col gap-1">
        <p className="text-caption text-ink-tertiary">Usage</p>
        <pre className="overflow-x-auto rounded-lg border border-hairline p-3 text-caption text-ink-secondary">
          <code>{snippet}</code>
        </pre>
      </div>

      <Dialog open={secret !== null} onOpenChange={(o) => !o && closeSecret()}>
        <DialogContent onInteractOutside={(e) => e.preventDefault()}>
          <DialogHeader>
            <DialogTitle>Your new API key</DialogTitle>
            <DialogDescription>
              Copy it now. For your security it will not be shown again; if you lose it, revoke it and create a new one.
            </DialogDescription>
          </DialogHeader>
          <code
            data-testid="new-key-secret"
            className="break-all rounded-lg border border-hairline p-3 text-caption text-ink-primary select-all"
          >
            {secret}
          </code>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={copy}>
              {copied ? "Copied" : "Copy"}
            </Button>
            <Button type="button" onClick={closeSecret}>
              I have saved it
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={toRevoke !== null} onOpenChange={(o) => !o && setToRevoke(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Revoke “{toRevoke?.name}”?</DialogTitle>
            <DialogDescription>
              Scripts using this key will stop working immediately. This cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setToRevoke(null)}>
              Cancel
            </Button>
            <Button
              type="button"
              disabled={revoke.isPending}
              onClick={() => toRevoke && revoke.mutate(toRevoke.id)}
            >
              {revoke.isPending ? "Revoking…" : "Revoke key"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
}
